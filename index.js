require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const EventEmitter = require('events');
const downloadEmitter = new EventEmitter();

let client;
(async () => {
  const { default: WebTorrent } = await import('webtorrent');
  client = new WebTorrent();
})();

const app = express();
const port = process.env.PORT || 3000;

const session = require('express-session');
const bodyParser = require('body-parser');

const USERNAME = process.env.AUTH_USERNAME;
const PASSWORD = process.env.AUTH_PASSWORD;
const TORRENT_TIMEOUT = process.env.TORRENT_TIMEOUT || 30000;

// Middleware to parse JSON request bodies
app.use(express.json());


app.use(session({
  secret: 'audiobook_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60 * 60 * 1000 } // 1 hour
}));

app.use(bodyParser.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
      next();
    } else {
      res.redirect('/login');
    }
  }
  
  app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
  });
  
  app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
      req.session.authenticated = true;
      res.redirect('/');
    } else {
      res.send('Invalid credentials. <a href="/login">Try again</a>.');
    }
  });
  

// Serve the index.html file at the root route.
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));



// Fixed base URLs from .env.
const baseUrls = process.env.BASE_URLS
  ? process.env.BASE_URLS.split(',').map(url => url.trim())
  : [];

// The absolute path where torrent files will be saved.
// Make sure LIBRARY_PATH is defined in your .env file.
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/absolute/path/to/library';

// Use a strict concurrency limit (only 1 task at a time).
const limitRequests = pLimit(5);

// Set global axios defaults so HTTP/HTTPS use default agents.
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Helper function to delay execution.
 * @param {number} ms - Milliseconds to delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to encode the search query so spaces become plus signs.
 * @param {string} query
 * @returns {string}
 */
function encodeSearchQuery(query) {
  return encodeURIComponent(query).replace(/%20/g, '+').toLowerCase();
}

/**
 * Attempts to fetch a URL by cycling through the fixed base URLs.
 * For each base, it tries up to 3 attempts with delays.
 * @param {string} path - The path and query to append to the base URL.
 * @returns {Promise<Object>} - { data, baseUsed }
 */
async function fetchWithBaseUrls(path) {
  for (const base of baseUrls) {
    const fullUrl = path.startsWith('http') ? path : `${base}${path}`;
    const maxAttempts = 3;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        const response = await axios.get(fullUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 500,
        });
        console.log(`Successfully fetched from base: ${base} on attempt ${attempts + 1}`);
        return { data: response.data, baseUsed: base };
      } catch (error) {
        attempts++;
        console.error(`Error fetching from ${base} on attempt ${attempts}: ${error.message}`);
        await sleep(100);
      }
    }
  }
  throw new Error('All base URLs failed after multiple attempts');
}

/**
 * Parses the search results page HTML and extracts audiobook details.
 * @param {string} html - Raw HTML from a search results page.
 * @returns {Promise<Array>} - Array of audiobook objects.
 */
async function parseAudiobookSearchResults(html) {
  const $ = cheerio.load(html);
  const posts = $('div.post').toArray();
  const results = await Promise.all(
    posts.map(elem =>
      limitRequests(async () => {
        const title = $(elem).find('div.postTitle h2 a').text().trim();
        const detailsUrl = $(elem).find('div.postMeta span.postLink a').attr('href');
        const metaText = $(elem).find('div.postContent p').last().text().trim();
        const imageUrl = $(elem).find('div.postContent .center a img').attr('src');
        await sleep(50);
        return { title, detailsUrl, metaText, imageUrl };
      })
    )
  );
  return results;
}

/**
 * Parses the pagination from the HTML to determine total pages.
 * @param {string} html
 * @returns {number}
 */
function getTotalPages(html) {
  const $ = cheerio.load(html);
  const lastPageLink = $('div.wp-pagenavi a[title="»»"]').attr('href');
  if (lastPageLink) {
    const match = lastPageLink.match(/\/page\/(\d+)\//);
    if (match && match[1]) return parseInt(match[1]);
  }
  return 1;
}

/**
 * Searches for audiobooks and handles pagination (first 5 pages).
 * @param {string} query - The search term.
 * @returns {Promise<Array>} - Combined results.
 */
async function searchAudiobooks(query) {
  const encodedQuery = encodeSearchQuery(query);
  // Build the search path to mimic browser behavior.
  const searchPath = `/?s=${encodedQuery}&cat=undefined%2Cundefined`;
  try {
    const { data: firstPageData } = await fetchWithBaseUrls(searchPath);
    await sleep(100);
    let results = await parseAudiobookSearchResults(firstPageData);
    const totalPages = getTotalPages(firstPageData);
    const pagesToFetch = Math.min(totalPages, 5);
    console.log(`Fetching pages 2 to ${pagesToFetch}`);
    if (pagesToFetch > 1) {
      const additionalPagesPromises = [];
      for (let page = 2; page <= pagesToFetch; page++) {
        const pagePath = `/page/${page}/?s=${encodedQuery}&cat=undefined%2Cundefined`;
        additionalPagesPromises.push(
          fetchWithBaseUrls(pagePath)
            .then(async res => {
              await sleep(100);
              return parseAudiobookSearchResults(res.data);
            })
            .catch(err => {
              console.error(`Error fetching page ${page}:`, err);
              return [];
            })
        );
      }
      const pagesResults = await Promise.all(additionalPagesPromises);
      results = results.concat(pagesResults.flat());
    }
    return results;
  } catch (error) {
    console.error('Error during search:', error);
    return [];
  }
}

// Express endpoint to perform a search.
app.get('/search', requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).send('Query parameter "q" is required');
  const results = await searchAudiobooks(query);
  res.json(results);
});

/**
 * Fetches the torrent link from the audiobook details page.
 * Retries several times if needed.
 * If the extracted torrent link is relative, prefixes it with the details URL's origin.
 * @param {string} detailsUrl - URL (or path) of the audiobook details page.
 * @returns {Promise<string|null>} - The torrent link if found, otherwise null.
 */
async function getTorrentLinkFromDetailsPage(detailsUrl) {
    const maxAttempts = 3;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        const response = await axios.get(detailsUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 500,
        });
        await sleep(100);
        const $ = cheerio.load(response.data);
        let torrentLink = $('a:contains("Torrent Free Downloads")').attr('href');
        if (torrentLink) {
          // If the torrent link is not absolute, prefix it with the details URL origin.
          if (!torrentLink.startsWith('http')) {
            const detailsUrlObj = new URL(detailsUrl);
            torrentLink = detailsUrlObj.origin + torrentLink;
          }
          return torrentLink;
        }
      } catch (error) {
        attempts++;
        console.error(`Error fetching details page ${detailsUrl} on attempt ${attempts}: ${error.message}`);
        await sleep(100);
      }
    }
    return null;
  }
  

  async function extractInfoHash(detailsUrl) {
    const { data } = await axios.get(detailsUrl, { timeout: 500 });
    const $ = cheerio.load(data);
    const infoHash = $('tr:contains("Info Hash:")').find('td').last().text().trim();
    return infoHash || null;
  }
  
  /**
 * Helper: wait for metadata or timeout
 */
function fetchMetadataOrTimeout(torrent, timeoutMs = TORRENT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        torrent.destroy();
        reject(new Error('torrent is dead (metadata timeout)'));
      }, timeoutMs);
  
      torrent.once('metadata', () => {
        clearTimeout(timer);
        resolve();
      });
  
      torrent.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
  
  app.post('/download', requireAuth, async (req, res) => {
    const urls = req.body.detailsUrls || [];
    const results = [];
  
    for (const url of urls) {
      try {
        const infoHash = await extractInfoHash(url);
        if (!infoHash) throw new Error('Info Hash not found');
  
        const magnet = `magnet:?xt=urn:btih:${infoHash}`;
        const torrentPath = path.join(LIBRARY_PATH, `${infoHash}.torrent`);
  
        const msg1 = `🔍 Starting metadata fetch for ${infoHash}`;
        console.log(msg1);
        downloadEmitter.emit('log', msg1);
  
        await new Promise((resolve, reject) => {
          const torrent = client.add(magnet, { path: LIBRARY_PATH });
          fetchMetadataOrTimeout(torrent, TORRENT_TIMEOUT)
            .then(() => {
              const msg2 = `✅ Metadata fetched for ${infoHash}`;
              console.log(msg2);
              downloadEmitter.emit('log', msg2);
  
              fs.writeFileSync(torrentPath, torrent.torrentFile);
              const msg3 = `💾 Saved .torrent to ${torrentPath}`;
              console.log(msg3);
              downloadEmitter.emit('log', msg3);
  
              torrent.destroy();
              resolve();
            })
            .catch(err => {
              const msgErr = `❌ ${infoHash} failed: ${err.message}`;
              console.error(msgErr);
              downloadEmitter.emit('log', msgErr);
              reject(err);
            });
        });
  
        results.push({ detailsUrl: url, infoHash, filepath: torrentPath, status: 'success' });
      } catch (error) {
        results.push({ detailsUrl: url, status: 'failed', error: error.message });
      }
    }
  
    // Emit a "done" event with final JSON results so the client knows we're finished.
    downloadEmitter.emit('log', 'Download process completed.');
    downloadEmitter.emit('done', JSON.stringify(results));
  
    // Also respond with the final results (in case the client needs them)
    res.json(results);
  });
  


  // SSE endpoint for live download logs
app.get('/download/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // send a comment every 30 sec to keep connection alive
  const interval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  // Listener for log events
  const logListener = (msg) => {
    res.write(`data: ${msg}\n\n`);
  };

  // Listener for done event (we send event type "done")
  const doneListener = (data) => {
    res.write(`event: done\ndata: ${data}\n\n`);
  };

  downloadEmitter.on('log', logListener);
  downloadEmitter.on('done', doneListener);

  req.on('close', () => {
    clearInterval(interval);
    downloadEmitter.removeListener('log', logListener);
    downloadEmitter.removeListener('done', doneListener);
    res.end();
  });
});

  
  
  

// Start the server.
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
