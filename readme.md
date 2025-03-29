# Audiobook Scraper

Audiobook Scraper is a Node.js application for scraping, downloading, and managing audiobook torrents from sources such as AudiobookBay. The application features:

- **Search & Browse**: Find audiobooks by search terms or by browsing categories.
- **Torrent Downloading**: Automatically scrape and download torrent files with progress tracking.
- **Collection Management**: Queue download requests, manage concurrency, and track real-time status.
- **Settings & Configuration**: Customizable settings via a built-in GUI and JSON configuration.
- **Multiple Deployment Options**: Local installation, PM2 management, or Docker container.

## Installation

### Local Installation

1. **Clone the Repository:**

```bash
git clone https://github.com/wilburforce83/audiobook-scraper.git
cd audiobook-scraper
```

2. **Install Dependencies:**

```bash
npm install
```

3. **Configure Application:**

The application automatically creates a `db/settings.json` file with default settings on the first run:

```json
{
  "username": "audio",
  "password": "bo0k5",
  "uiport": 3000,
  "audiobookShelfPath": "/audiobooks",
  "audiobookbayURLs": "https://audiobookbay.lu,http://audiobookbay.se",
  "maxTorrents": 5,
  "torrentTimeout": 30000,
  "excludeRomance": true
}
```

4. **Start the Application:**

```bash
node index.js
```

5. **Access the Web Interface:**

Navigate to [http://localhost:3000](http://localhost:3000).

## Using PM2

1. **Install PM2:**

```bash
npm install -g pm2
```

2. **Run with PM2:**

```bash
pm2 start index.js --name audiobook-scraper
```

3. **Monitor and Manage:**

```bash
pm2 logs audiobook-scraper
pm2 restart audiobook-scraper
pm2 save
```

## Docker Deployment

**Important**: When using Docker, the `audiobookShelfPath` must be set to a Docker container path (e.g., `/app/library`) and then bound to your local host Audiobookshelf library path using Docker volumes. This ensures downloads correctly populate your local Audiobookshelf library.

1. **Build Docker Image:**

```bash
docker build -t wilburforce83/audiobook-scraper:latest .
```

2. **Run Docker Container:**

```bash
docker run -it --rm -p 3000:3000 -v $(pwd)/db:/app/db -v /your/local/library:/app/audiobooks wilburforce83/audiobook-scraper:latest
```

3. **Docker Compose:**

```yaml
version: '3'
services:
  audiobook-scraper:
    image: wilburforce83/audiobook-scraper:latest
    container_name: audiobook-scraper
    restart: always
    ports:
      - "3000:3000"
    volumes:
      - ./db:/app/db
      - /your/local/library:/app/audiobooks
```

## Configuration

Settings are managed via the built-in GUI or directly through `db/settings.json`. Changes to critical settings such as `uiport` and `audiobookShelfPath` require a server restart.

## Usage

- **Search:** Enter queries to find audiobooks.
- **Browse Categories:** Explore audiobooks by categories.
- **Request Books:** Select audiobooks to queue for downloading.
- **Manage Downloads:** Monitor real-time progress and status.

## API Overview

- `GET /search?q=query` – Search for audiobooks.
- `GET /browse?p=path` – Browse specific categories.
- `POST /download` – Queue audiobooks for download.
- `DELETE /collection/completed` – Remove completed downloads.

## Support

For support, visit the [GitHub repository](https://github.com/wilburforce83/audiobook-scraper).

