# Audiobook Scraper

A Node.js-based tool to search for audiobooks from ABB, extract book details, and download torrent files directly to your library via a torrent watch folder. 

DOES NOT require an ABB account as the app only pulls the has data and builds it's own torrent from that.

Includes a simple dark-themed frontend with interactive search and download functionality.

## Features

- Search audiobooks from Audiobookbay.
- collect the results from the first 5 pages of a given search.
- Display results in a responsive, dark-themed table.
- Select individual or multiple audiobooks via tick box.
- Download torrent files directly to your watch folder.
- Toast notifications for actions and feedback.
- Fully containerized via PM2 for stability and restart on failure.

---

## Prerequisites

- Node.js v18+
- PM2 (for process management)
- `.env` file configured with:
  ```
  BASE_URLS=https://audiobookbay.lu
  LIBRARY_PATH=/your/absolute/library/path
  ```

---

## Getting Started

### 1. Clone the repository
```bash
git clone https://github.com/wilburforce83/audiobook-scraper
cd audiobook-scraper
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set environment variables
Create a `.env` file in the root directory:
```bash
BASE_URLS=https://audiobookbay.lu // or the latest URL proxy
LIBRARY_PATH=/absolute/path/to/your/library // your deluge/tranmission etc watch folder.
PORT=3000
```

### 4. Run locally (for testing)
```bash
node index.js
```
Visit `http://localhost:3000`

---

## PM2 Setup (Production)

### 1. Install PM2 globally
```bash
npm install -g pm2
```

### 2. Start the app with PM2
```bash
pm2 start index.js --name audiobook-scraper
```

### 3. Enable on system reboot
```bash
pm2 startup
# Follow instructions e.g., `sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u your-username --hp /home/your-username`
pm2 save
```

### 4. Monitor logs
```bash
pm2 logs audiobook-scraper
```

---

## Frontend Features
- **Search form** for entering audiobook titles.
- **Loading spinner** while fetching results.
- **Paginated results** with book title, metadata, and images.
- **Checkboxes** for multi-select.
- **"Download to Library" button** appears when one or more items are selected.
- **Toast notifications** in bottom-right corner for success/error messages.

---

## Notes
- Only torrent metadata is fetched (via magnet link info hash).
- Torrents are downloaded as `.torrent` files to the path specified in `LIBRARY_PATH`.
- The actual content of the torrent is **not** downloaded.

## Future Enhancements
- Add authentication/login flow if needed.
- Support for downloading actual audiobook content.
- Additional UI improvements (filters, sorting, etc.).
- Enhanced error handling and retry logic.

---

## License
MIT License (or insert your preferred license here).

---

## Author
- Your Name / Handle

---

Feel free to adjust paths, repo URL, and environment variables to suit your setup.

