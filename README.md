# Videos Downloader +*!¡ 

A simple yet powerful command-line tool to download videos from 1000+ websites including YouTube, Vimeo, Twitter, Instagram, TikTok, and more.

## Features

- **Multi-platform support**: Downloads from YouTube, Vimeo, Twitter, Instagram, TikTok, and 1000+ other sites
- **High-quality downloads**: Automatically selects the best available quality
- **Audio extraction**: Download audio-only files in MP3 format
- **Batch processing**: Download multiple videos from a text file
- **Real-time progress**: Shows download progress with speed and ETA
- **Simple interface**: Easy-to-use command-line tool

## Prerequisites

- Python 3.7 or higher (with yt-dlp)
- Node.js (for the desktop app)
- ffmpeg (optional, but recommended for best quality)

## Installation

1. **Clone or download this repository**

2. **Install required Python packages:**
   ```bash
   pip install yt-dlp
   ```

3. **Install ffmpeg (recommended for best quality):**
   
   **Windows:**
   ```bash
   winget install ffmpeg
   ```
   
   **macOS:**
   ```bash
   brew install ffmpeg
   ```
   
   **Linux:**
   ```bash
   sudo apt install ffmpeg
   ```

## Desktop App (playlists)

An Electron desktop app (same style as my other apps) built on top of yt-dlp.

**Run it:**
```bash
npm install
npm start
```
After the first `npm install`, you can also double-click **`Videos Downloader.bat`**.

**Use it:**
1. Paste a YouTube **playlist** link (or a single video link) and press **Load**. Every video shows up with its thumbnail and length.
2. Choose **Video · MP4** with a max quality, or **Audio · MP3** (with the cover image and info embedded).
3. Optionally pick a browser under **Cookies from** for age-restricted or private videos.
4. Untick anything you don't want, then press **Download**.

By default, files go to `Videos\Videos Downloader`, with each playlist in its own folder and the files numbered in playlist order (`01 - Title.mp4`). Your choices are remembered between sessions. Files that already exist are skipped, so after cancelling or a failure you can run it again and it continues where it stopped. A video that fails (for example, a private one) is marked as failed, and the rest of the playlist still downloads.

**Requirements:** yt-dlp (`pip install yt-dlp`) and ffmpeg (`winget install ffmpeg`). The badge in the top right of the app shows whether both were found. You can also put `yt-dlp.exe` and `ffmpeg.exe` in the `bin` folder, where the app prefers them over installed copies and bundles them into the installer.

**Build a Windows installer:**
```bash
npm run dist
```
The installer is created in `dist/`.

## Command Line Usage

### Download a single video

```bash
python downloader.py "https://youtube.com/watch?v=VIDEO_ID"
```

### Download audio only

```bash
python downloader.py "https://youtube.com/watch?v=VIDEO_ID" --audio
```

### Batch download multiple videos

1. Create a text file (e.g., `urls.txt`) with one URL per line:
   ```
   https://youtube.com/watch?v=VIDEO_ID_1
   https://youtube.com/watch?v=VIDEO_ID_2
   https://vimeo.com/123456789
   ```

2. Run the batch download:
   ```bash
   python downloader.py --batch urls.txt
   ```

## Examples

```bash
# Download a YouTube video
python downloader.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

# Extract audio from a music video
python downloader.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ" --audio

# Download multiple videos from a list
python downloader.py --batch my_playlist.txt
```

## Output

Downloaded files are saved in the `downloads` folder (created automatically) with the video title as the filename.

## Troubleshooting

### "pip is not recognized"
Use `python -m pip install yt-dlp` instead

### "ffmpeg is not installed"
Either install ffmpeg (recommended) or the script will automatically fall back to a single format that doesn't require merging

### Download fails
- Check your internet connection
- Verify the URL is correct and accessible
- Some sites may have geographical restrictions

## Supported Sites

This tool supports over 1000 websites including:
- YouTube
- Vimeo
- Twitter/X
- Instagram
- TikTok
- Facebook
- Reddit
- Twitch
- And many more...

For a complete list, visit: [yt-dlp supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md)

## Legal Notice

This tool is for personal use only. Please respect copyright laws and the terms of service of the websites you download from. Only download content you have permission to download!!!!!

## License

This project is open source and available under the MIT License.

## Credits

Built with [yt-dlp](https://github.com/yt-dlp/yt-dlp) - A youtube-dl fork with additional features and fixes.
