#!/usr/bin/env python3
"""
Videos Downloader - desktop app
Paste a YouTube playlist (or single video) link, load it, and download every
item as MP4 video or MP3 audio. Requires: pip install yt-dlp  (+ ffmpeg)
"""

import queue
import re
import shutil
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

import yt_dlp
from yt_dlp.utils import DownloadCancelled

APP_TITLE = "Videos Downloader"
DEFAULT_OUTPUT = Path(__file__).resolve().parent / "downloads"
QUALITIES = ["Best", "2160p", "1440p", "1080p", "720p", "480p", "360p"]
BROWSERS = ["None", "chrome", "firefox", "edge", "brave", "opera"]


def js_runtimes():
    """YouTube needs a JS runtime; enable whichever ones are installed."""
    found = {name: {} for name in ("deno", "node", "bun") if shutil.which(name)}
    return found or None


def safe_name(text):
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .") or "playlist"


class QuietLogger:
    """Route yt-dlp messages to the app log instead of the console."""

    def __init__(self, emit):
        self.emit = emit

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        self.emit("log", f"Warning: {msg}")

    def error(self, msg):
        self.emit("log", msg)


class DownloaderApp:
    def __init__(self, root):
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry("900x620")
        self.root.minsize(720, 480)

        self.events = queue.Queue()
        self.cancel_flag = threading.Event()
        self.worker = None
        self.entries = []          # list of dicts: id, url, title, duration
        self.playlist_title = ""

        self.url_var = tk.StringVar()
        self.mode_var = tk.StringVar(value="video")
        self.quality_var = tk.StringVar(value="Best")
        self.output_var = tk.StringVar(value=str(DEFAULT_OUTPUT))
        self.browser_var = tk.StringVar(value="None")
        self.subfolder_var = tk.BooleanVar(value=True)
        self.number_var = tk.BooleanVar(value=True)
        self.status_var = tk.StringVar(value="Paste a playlist link and press Load.")

        self._build_ui()
        self.root.after(100, self._drain_events)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    # ------------------------------------------------------------------ UI
    def _build_ui(self):
        pad = {"padx": 8, "pady": 4}
        main = ttk.Frame(self.root, padding=10)
        main.pack(fill="both", expand=True)

        # Link row
        link = ttk.Frame(main)
        link.pack(fill="x")
        ttk.Label(link, text="Playlist / video link:").pack(side="left")
        entry = ttk.Entry(link, textvariable=self.url_var)
        entry.pack(side="left", fill="x", expand=True, padx=6)
        entry.bind("<Return>", lambda e: self.load())
        ttk.Button(link, text="Paste", command=self._paste).pack(side="left")
        self.load_btn = ttk.Button(link, text="Load", command=self.load)
        self.load_btn.pack(side="left", padx=(6, 0))

        # Options
        opts = ttk.LabelFrame(main, text="Options", padding=6)
        opts.pack(fill="x", pady=8)

        ttk.Label(opts, text="Format:").grid(row=0, column=0, sticky="w", **pad)
        ttk.Radiobutton(opts, text="Video (MP4)", variable=self.mode_var,
                        value="video", command=self._mode_changed).grid(row=0, column=1, sticky="w")
        ttk.Radiobutton(opts, text="Audio (MP3)", variable=self.mode_var,
                        value="audio", command=self._mode_changed).grid(row=0, column=2, sticky="w")

        ttk.Label(opts, text="Max quality:").grid(row=0, column=3, sticky="e", **pad)
        self.quality_box = ttk.Combobox(opts, textvariable=self.quality_var, values=QUALITIES,
                                        state="readonly", width=8)
        self.quality_box.grid(row=0, column=4, sticky="w")

        ttk.Label(opts, text="Cookies from:").grid(row=0, column=5, sticky="e", **pad)
        ttk.Combobox(opts, textvariable=self.browser_var, values=BROWSERS,
                     state="readonly", width=9).grid(row=0, column=6, sticky="w")

        ttk.Label(opts, text="Save to:").grid(row=1, column=0, sticky="w", **pad)
        ttk.Entry(opts, textvariable=self.output_var).grid(row=1, column=1, columnspan=5,
                                                          sticky="ew", pady=4)
        ttk.Button(opts, text="Browse…", command=self._browse).grid(row=1, column=6, sticky="w", padx=4)

        ttk.Checkbutton(opts, text="Put playlist in its own folder",
                        variable=self.subfolder_var).grid(row=2, column=1, columnspan=2, sticky="w")
        ttk.Checkbutton(opts, text="Number files by playlist order",
                        variable=self.number_var).grid(row=2, column=3, columnspan=3, sticky="w")
        opts.columnconfigure(5, weight=1)

        # Items table
        table = ttk.Frame(main)
        table.pack(fill="both", expand=True)
        cols = ("n", "title", "duration", "status")
        self.tree = ttk.Treeview(table, columns=cols, show="headings", selectmode="extended")
        for col, text, width, anchor in (("n", "#", 45, "center"), ("title", "Title", 480, "w"),
                                         ("duration", "Length", 70, "center"),
                                         ("status", "Status", 170, "w")):
            self.tree.heading(col, text=text)
            self.tree.column(col, width=width, anchor=anchor, stretch=(col == "title"))
        sb = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.tree.tag_configure("done", foreground="#1a7f37")
        self.tree.tag_configure("error", foreground="#cf222e")
        self.tree.tag_configure("active", foreground="#0969da")

        # Progress + buttons
        bottom = ttk.Frame(main)
        bottom.pack(fill="x", pady=(8, 0))
        self.item_bar = ttk.Progressbar(bottom, maximum=100)
        self.item_bar.pack(fill="x")
        self.total_bar = ttk.Progressbar(bottom, maximum=100)
        self.total_bar.pack(fill="x", pady=(4, 0))

        actions = ttk.Frame(main)
        actions.pack(fill="x", pady=(6, 0))
        ttk.Label(actions, textvariable=self.status_var).pack(side="left", fill="x", expand=True)
        ttk.Button(actions, text="Open folder", command=self._open_folder).pack(side="right")
        self.cancel_btn = ttk.Button(actions, text="Cancel", command=self.cancel, state="disabled")
        self.cancel_btn.pack(side="right", padx=6)
        self.dl_sel_btn = ttk.Button(actions, text="Download selected",
                                     command=lambda: self.download(selected_only=True), state="disabled")
        self.dl_sel_btn.pack(side="right")
        self.dl_all_btn = ttk.Button(actions, text="Download all",
                                     command=self.download, state="disabled")
        self.dl_all_btn.pack(side="right", padx=6)

        # Log
        self.log = tk.Text(main, height=5, state="disabled", wrap="word")
        self.log.pack(fill="x", pady=(8, 0))

    def _mode_changed(self):
        self.quality_box.configure(state="readonly" if self.mode_var.get() == "video" else "disabled")

    def _paste(self):
        try:
            self.url_var.set(self.root.clipboard_get().strip())
        except tk.TclError:
            pass

    def _browse(self):
        folder = filedialog.askdirectory(initialdir=self.output_var.get() or str(DEFAULT_OUTPUT))
        if folder:
            self.output_var.set(folder)

    def _open_folder(self):
        folder = Path(self.output_var.get())
        folder.mkdir(parents=True, exist_ok=True)
        import os
        os.startfile(folder)  # Windows

    def _set_busy(self, busy):
        state = "disabled" if busy else "normal"
        self.load_btn.configure(state=state)
        has_items = "normal" if (self.entries and not busy) else "disabled"
        self.dl_all_btn.configure(state=has_items)
        self.dl_sel_btn.configure(state=has_items)
        self.cancel_btn.configure(state="normal" if busy else "disabled")

    def _write_log(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    # ------------------------------------------------------ thread → UI
    def emit(self, kind, *data):
        self.events.put((kind, *data))

    def _drain_events(self):
        try:
            while True:
                kind, *data = self.events.get_nowait()
                getattr(self, f"_on_{kind}")(*data)
        except queue.Empty:
            pass
        self.root.after(100, self._drain_events)

    def _on_log(self, text):
        self._write_log(text)

    def _on_status(self, text):
        self.status_var.set(text)

    def _on_loaded(self, title, entries):
        self.playlist_title, self.entries = title, entries
        self.tree.delete(*self.tree.get_children())
        for i, e in enumerate(entries, 1):
            self.tree.insert("", "end", iid=str(i - 1),
                             values=(i, e["title"], fmt_duration(e["duration"]), "Waiting"))
        self.status_var.set(f"{title} — {len(entries)} item(s) loaded.")
        self._write_log(f"Loaded: {title} ({len(entries)} items)")

    def _on_row(self, index, status, tag=""):
        iid = str(index)
        if self.tree.exists(iid):
            vals = list(self.tree.item(iid, "values"))
            vals[3] = status
            self.tree.item(iid, values=vals, tags=(tag,) if tag else ())
            if tag == "active":
                self.tree.see(iid)

    def _on_item_progress(self, pct):
        self.item_bar["value"] = pct

    def _on_total_progress(self, pct):
        self.total_bar["value"] = pct

    def _on_finished(self, summary):
        self._set_busy(False)
        self.item_bar["value"] = 0
        self.status_var.set(summary)
        self._write_log(summary)

    # --------------------------------------------------------- actions
    def base_opts(self):
        opts = {
            "quiet": True,
            "no_warnings": False,
            "noprogress": True,
            "logger": QuietLogger(self.emit),
        }
        runtimes = js_runtimes()
        if runtimes:
            opts["js_runtimes"] = runtimes
            opts["remote_components"] = ["ejs:github"]
        if self.browser_var.get() != "None":
            opts["cookiesfrombrowser"] = (self.browser_var.get(),)
        return opts

    def load(self):
        url = self.url_var.get().strip()
        if not url:
            messagebox.showinfo(APP_TITLE, "Paste a playlist or video link first.")
            return
        self.cancel_flag.clear()
        self._set_busy(True)
        self.status_var.set("Reading playlist…")
        self.worker = threading.Thread(target=self._load_worker, args=(url,), daemon=True)
        self.worker.start()

    def _load_worker(self, url):
        opts = self.base_opts() | {"extract_flat": "in_playlist", "skip_download": True}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)
        except Exception as exc:
            self.emit("log", f"Could not read link: {exc}")
            self.emit("finished", "Failed to load link.")
            return

        if info.get("_type") == "playlist":
            entries = []
            for e in info.get("entries") or []:
                if not e:
                    continue
                vid_url = e.get("url") or e.get("webpage_url")
                if e.get("ie_key") == "Youtube" or (vid_url and "://" not in vid_url):
                    vid_url = f"https://www.youtube.com/watch?v={e['id']}"
                entries.append({"id": e.get("id"), "url": vid_url,
                                "title": e.get("title") or e.get("id") or "(untitled)",
                                "duration": e.get("duration")})
            title = info.get("title") or "Playlist"
        else:
            entries = [{"id": info.get("id"), "url": info.get("webpage_url") or url,
                        "title": info.get("title") or "(untitled)",
                        "duration": info.get("duration")}]
            title = "Single video"

        self.emit("loaded", title, entries)
        self.emit("finished", f"{title} — {len(entries)} item(s) ready to download.")

    def download(self, selected_only=False):
        if not self.entries:
            return
        if selected_only:
            indices = sorted(int(i) for i in self.tree.selection())
            if not indices:
                messagebox.showinfo(APP_TITLE, "Select one or more rows first.")
                return
        else:
            indices = list(range(len(self.entries)))

        if not shutil.which("ffmpeg"):
            if not messagebox.askyesno(APP_TITLE, "ffmpeg was not found. Without it, videos may be "
                                       "lower quality and MP3 conversion won't work.\n\nContinue anyway?"):
                return

        out = Path(self.output_var.get() or DEFAULT_OUTPUT)
        if self.subfolder_var.get() and self.playlist_title != "Single video":
            out = out / safe_name(self.playlist_title)
        out.mkdir(parents=True, exist_ok=True)

        self.cancel_flag.clear()
        self._set_busy(True)
        self.total_bar["value"] = 0
        settings = {
            "mode": self.mode_var.get(),
            "quality": self.quality_var.get(),
            "number": self.number_var.get() and len(self.entries) > 1,
            "out": out,
        }
        self.worker = threading.Thread(target=self._download_worker,
                                       args=(indices, settings), daemon=True)
        self.worker.start()

    def cancel(self):
        self.cancel_flag.set()
        self.status_var.set("Cancelling…")

    def _download_worker(self, indices, s):
        width = max(2, len(str(len(self.entries))))
        ok = failed = 0
        for pos, idx in enumerate(indices):
            if self.cancel_flag.is_set():
                break
            entry = self.entries[idx]
            self.emit("row", idx, "Starting…", "active")
            self.emit("status", f"[{pos + 1}/{len(indices)}] {entry['title']}")
            self.emit("item_progress", 0)

            prefix = f"{idx + 1:0{width}d} - " if s["number"] else ""
            opts = self.base_opts() | {
                "outtmpl": str(s["out"] / f"{prefix}%(title)s.%(ext)s"),
                "windowsfilenames": True,
                "noplaylist": True,
                "progress_hooks": [self._make_progress_hook(idx)],
                "postprocessor_hooks": [self._make_pp_hook(idx)],
                "overwrites": False,
                "continuedl": True,
            }
            if s["mode"] == "audio":
                opts["format"] = "bestaudio/best"
                opts["postprocessors"] = [{"key": "FFmpegExtractAudio",
                                           "preferredcodec": "mp3", "preferredquality": "192"},
                                          {"key": "FFmpegMetadata"}]
            else:
                q = s["quality"]
                limit = f"[height<={q[:-1]}]" if q != "Best" else ""
                opts["format"] = f"bestvideo{limit}+bestaudio/best{limit}/best"
                opts["merge_output_format"] = "mp4"

            try:
                with yt_dlp.YoutubeDL(opts) as ydl:
                    code = ydl.download([entry["url"]])
                if code:
                    raise RuntimeError("yt-dlp reported an error")
                ok += 1
                self.emit("row", idx, "Done ✓", "done")
            except DownloadCancelled:
                self.emit("row", idx, "Cancelled", "error")
                break
            except Exception as exc:
                failed += 1
                msg = str(exc).replace("ERROR: ", "")
                self.emit("row", idx, "Failed ✗", "error")
                self.emit("log", f"✗ {entry['title']}: {msg}")
            self.emit("total_progress", (pos + 1) / len(indices) * 100)

        cancelled = " (cancelled)" if self.cancel_flag.is_set() else ""
        self.emit("finished", f"Finished{cancelled}: {ok} downloaded, {failed} failed. Saved to {s['out']}")

    def _make_progress_hook(self, idx):
        def hook(d):
            if self.cancel_flag.is_set():
                raise DownloadCancelled("Cancelled by user")
            if d["status"] == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate")
                pct = d.get("downloaded_bytes", 0) / total * 100 if total else 0
                self.emit("item_progress", pct)
                speed = (d.get("_speed_str") or "").strip()
                self.emit("row", idx, f"Downloading {pct:4.1f}% {speed}", "active")
            elif d["status"] == "finished":
                self.emit("item_progress", 100)
        return hook

    def _make_pp_hook(self, idx):
        def hook(d):
            if d["status"] == "started":
                pp = d.get("postprocessor") or ""
                name = ("Merging" if "Merger" in pp else
                        "Converting to MP3" if "ExtractAudio" in pp else
                        "Adding metadata" if "Metadata" in pp else "Processing")
                self.emit("row", idx, f"{name}…", "active")
        return hook

    def _on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(APP_TITLE, "A download is running. Quit anyway?"):
                return
            self.cancel_flag.set()
        self.root.destroy()


def fmt_duration(seconds):
    if not seconds:
        return ""
    seconds = int(seconds)
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def main():
    root = tk.Tk()
    try:
        ttk.Style(root).theme_use("vista")
    except tk.TclError:
        pass
    DownloaderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
