import yt_dlp
import sys
from pathlib import Path

def download_video(url, output_path='downloads', use_cookies=False, browser='chrome'):
    Path(output_path).mkdir(parents=True, exist_ok=True)
    
    ydl_opts = {
        'format': 'bestvideo+bestaudio/best',  
        'outtmpl': f'{output_path}/%(title)s.%(ext)s',  
        'merge_output_format': 'mp4',  
        'progress_hooks': [progress_hook],
    }
    
    if use_cookies:
        ydl_opts['cookiesfrombrowser'] = (browser,)
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            print(f"Downloading from: {url}")
            info = ydl.extract_info(url, download=True)
            print(f"\n✓ Downloaded: {info.get('title', 'video')}")
            return True
    except Exception as e:
        print(f"✗ Error downloading: {e}")
        return False

def progress_hook(d):
    if d['status'] == 'downloading':
        percent = d.get('_percent_str', 'N/A')
        speed = d.get('_speed_str', 'N/A')
        eta = d.get('_eta_str', 'N/A')
        print(f"\rProgress: {percent} | Speed: {speed} | ETA: {eta}", end='')
    elif d['status'] == 'finished':
        print("\nDownload complete, processing...")

def download_audio_only(url, output_path='downloads', use_cookies=False, browser='chrome'):
    Path(output_path).mkdir(parents=True, exist_ok=True)
    
    ydl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': f'{output_path}/%(title)s.%(ext)s',
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'progress_hooks': [progress_hook],
    }
    
    if use_cookies:
        ydl_opts['cookiesfrombrowser'] = (browser,)
    
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            print(f"Downloading audio from: {url}")
            info = ydl.extract_info(url, download=True)
            print(f"\n✓ Downloaded: {info.get('title', 'audio')}")
            return True
    except Exception as e:
        print(f"✗ Error downloading: {e}")
        return False

def batch_download(urls_file, output_path='downloads', use_cookies=False, browser='chrome'):
    try:
        with open(urls_file, 'r') as f:
            urls = [line.strip() for line in f if line.strip()]
        
        print(f"Found {len(urls)} URLs to download\n")
        
        success = 0
        for i, url in enumerate(urls, 1):
            print(f"\n[{i}/{len(urls)}]")
            if download_video(url, output_path, use_cookies, browser):
                success += 1
        
        print(f"\n\nCompleted: {success}/{len(urls)} successful downloads")
    except FileNotFoundError:
        print(f"Error: File '{urls_file}' not found")

def main():
    if len(sys.argv) < 2:
        print("Video Downloader")
        print("\nUsage:")
        print("  Single video:  python downloader.py <URL>")
        print("  Audio only:    python downloader.py <URL> --audio")
        print("  Batch mode:    python downloader.py --batch <file.txt>")
        print("  With cookies:  python downloader.py <URL> --cookies [browser]")
        print("\nExamples:")
        print("  python downloader.py https://youtube.com/watch?v=example")
        print("  python downloader.py https://youtube.com/watch?v=example --cookies")
        print("  python downloader.py https://youtube.com/watch?v=example --cookies firefox")
        print("  python downloader.py https://vimeo.com/123456 --audio")
        print("  python downloader.py --batch urls.txt --cookies")
        sys.exit(1)
    
    # Check for cookies flag
    use_cookies = '--cookies' in sys.argv
    browser = 'chrome'  # default
    
    if use_cookies:
        # Check if browser is specified after --cookies
        try:
            cookies_index = sys.argv.index('--cookies')
            if cookies_index + 1 < len(sys.argv) and not sys.argv[cookies_index + 1].startswith('-'):
                browser = sys.argv[cookies_index + 1]
        except (ValueError, IndexError):
            pass
    
    if sys.argv[1] == '--batch':
        if len(sys.argv) < 3:
            print("Error: Please provide a file with URLs")
            sys.exit(1)
        batch_download(sys.argv[2], use_cookies=use_cookies, browser=browser)
    elif '--audio' in sys.argv:
        url = sys.argv[1]
        download_audio_only(url, use_cookies=use_cookies, browser=browser)
    else:
        url = sys.argv[1]
        download_video(url, use_cookies=use_cookies, browser=browser)

if __name__ == '__main__':
    main()