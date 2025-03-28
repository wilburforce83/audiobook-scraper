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
const cron = require('node-cron');

const downloadEmitter = new EventEmitter();


// Path for the settings file
const settingsFilePath = path.join(__dirname, 'db', 'settings.json');

// Default settings
const defaultSettings = {
  username: "audio",
  password: "bo0k5",
  uiport: 3000,
  audiobookShelfPath: "/path/to/shelf",
  audiobookbayURLs: "https://audiobookbay.lu,http://audiobookbay.se",
  maxTorrents: 5,
  torrentTimeout: 30000
};

// Helper: load settings from file
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFilePath, 'utf8'));
  } catch (err) {
    return null; // indicates missing or invalid file
  }
}

// Helper: save settings to file
function saveSettings(settings) {
  fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2));
}

// On server start: if no file, create it with default data
if (!fs.existsSync(settingsFilePath)) {
  console.log("No settings.json found; creating default file.");
  saveSettings(defaultSettings);
} else {
  // Optionally validate or merge with defaults if you want
  console.log("settings.json found; using existing settings.");
}


// WebTorrent client
let client;
(async () => {
  const { default: WebTorrent } = await import('webtorrent');
  client = new WebTorrent();
  console.log('WebTorrent client created in Node. Resuming active/queued torrents...');
  resumeActiveTorrents(); // call your resume logic here
})();


const app = express();

const session = require('express-session');
const bodyParser = require('body-parser');
let USERNAME;
let PASSWORD;
let TORRENT_TIMEOUT;
let MAX_ACTIVE_TORRENTS;
let port;
let LIBRARY_PATH;
let baseUrls;

function reloadSettings() {
  const s = loadSettings();
  USERNAME = s.username;
  PASSWORD = s.password;
  TORRENT_TIMEOUT = s.torrentTimeout;
  MAX_ACTIVE_TORRENTS = s.maxTorrents;
  port = s.uiport;
  LIBRARY_PATH = s.audiobookShelfPath;
  baseUrls = s.audiobookbayURLs
    ? s.audiobookbayURLs.split(',').map(url => url.trim())
    : [];
}

reloadSettings();


// Basic config
app.use(express.json());
app.use(session({
  secret: 'audiobook_secret_key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 60 * 60 * 1000 }
}));
app.use(bodyParser.urlencoded({ extended: true }));

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    next();
  } else {
    res.redirect('/login');
  }
}

// Simple login
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

// Serve main index
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Env config



const limitRequests = pLimit(5);

// Global axios defaults
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function encodeSearchQuery(query) {
  return encodeURIComponent(query).replace(/%20/g, '+').toLowerCase();
}

// Attempt to fetch a path from any of the baseUrls
async function fetchWithBaseUrls(path) {
  for (const base of baseUrls) {
    const fullUrl = path.startsWith('http') ? path : `${base}${path}`;
    const maxAttempts = 3;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        const response = await axios.get(fullUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 1500,
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

// parse results
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

function getTotalPages(html) {
  const $ = cheerio.load(html);
  const lastPageLink = $('div.wp-pagenavi a[title="»»"]').attr('href');
  if (lastPageLink) {
    const match = lastPageLink.match(/\/page\/(\d+)\//);
    if (match && match[1]) return parseInt(match[1]);
  }
  return 1;
}

async function searchAudiobooks(query, browse = false) {
  const encodedQuery = browse ? query.replace(/\/$/, '') : encodeSearchQuery(query);
  const searchPath = browse ? encodedQuery : `/?s=${encodedQuery}&cat=undefined%2Cundefined`;
  
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
        const pagePath = browse ? `${encodedQuery}/page/${page}/` : `/page/${page}/?s=${encodedQuery}&cat=undefined%2Cundefined`;

        console.log(pagePath);
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

// /search route
app.get('/search', requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).send('Query parameter "q" is required');
  const results = await searchAudiobooks(query);
  res.json(results);
});

// /browse route
app.get('/browse', requireAuth, async (req, res) => {
  const query = req.query.p;
  if (!query) return res.status(400).send('Browse location does not exist');
  const results = await searchAudiobooks(query, true);
  res.json(results);
});

/* 
 * Helper: extract infoHash from details page 
 */
async function extractInfoHash(detailsUrl) {
  const { data } = await axios.get(detailsUrl, { timeout: 5000 });
  const $ = cheerio.load(data);
  const infoHash = $('tr:contains("Info Hash:")').find('td').last().text().trim();
  return infoHash || null;
}

/*
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

/* 
 * collection.json => store items with statuses 
 */
const collectionFilePath = path.join(__dirname, 'db', 'collection.json');

function loadCollection() {
  try {
    return JSON.parse(fs.readFileSync(collectionFilePath, 'utf8'));
  } catch (err) {
    return [];
  }
}
function saveCollection(collection) {
  fs.writeFileSync(collectionFilePath, JSON.stringify(collection, null, 2));
}

// update or insert an item in the array
function updateItemInCollection(item) {
  const coll = loadCollection();
  for (let i = 0; i < coll.length; i++) {
    if (coll[i].detailsUrl === item.detailsUrl) {
      coll[i] = item;
      saveCollection(coll);
      return;
    }
  }
  // not found, push new
  coll.push(item);
  saveCollection(coll);
}

// get how many are "downloading"
function getActiveDownloadCount(coll) {
  return coll.filter(it => it.status === 'downloading').length;
}

/* 
 * /download => store item(s) with status "wanted", hash "", progress=0
 */
app.post('/download', requireAuth, async (req, res) => {
  const { detailsUrls = [], titles = [] } = req.body;
  if (!detailsUrls.length) {
    return res.json({ message: 'No detailsUrls provided', status: 'ok' });
  }
  let coll = loadCollection();
  for (let i = 0; i < detailsUrls.length; i++) {
    const url = detailsUrls[i];
    const thisTitle = titles[i] || 'Unknown Title';
    const newObj = {
      title: thisTitle,
      detailsUrl: url,
      status: 'wanted',
      hash: '',
      filename: '',
      attempts: 0,
      progress: 0.0
    };
    coll.push(newObj);
  }
  saveCollection(coll);

  console.log(`Added ${detailsUrls.length} item(s) to collection with status "wanted".`);
  res.json({ message: 'Added to collection', count: detailsUrls.length });
});

// SSE route for streaming collection changes
app.get('/collection/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const keepAliveInterval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  function sendCollectionData() {
    try {
      const data = JSON.parse(fs.readFileSync(collectionFilePath, 'utf8'));
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('Error reading collection file:', err);
    }
  }

  fs.watchFile(collectionFilePath, { interval: 1000 }, sendCollectionData);
  sendCollectionData();

  req.on('close', () => {
    clearInterval(keepAliveInterval);
    fs.unwatchFile(collectionFilePath, sendCollectionData);
    res.end();
  });
});

// older SSE logs
app.get('/download/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const interval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  const logListener = (msg) => {
    res.write(`data: ${msg}\n\n`);
  };
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

/*
 * startTorrentDownload => begin actual torrent in memory, track progress 
 */
function startTorrentDownload(item) {
  const magnet = `magnet:?xt=urn:btih:${item.hash}`;
  const torrent = client.add(magnet, { path: LIBRARY_PATH });

  item.status = 'downloading';
  item.progress = 0.0;
  updateItemInCollection(item);

  // Once metadata is fetched, we do nothing special unless you want to store a .torrent
  torrent.once('metadata', () => {
    console.log(`Metadata found for hash=${item.hash}, title="${item.title}"`);
  });

  // On each download chunk => update progress
  torrent.on('download', bytes => {
    const prog = torrent.progress; // 0..1
    item.progress = prog;
    item.status = 'downloading';
    updateItemInCollection(item);
  });

  // On done => set status=completed
  torrent.once('done', () => {
    item.progress = 1.0;
    item.status = 'completed';

    // Optionally create .torrent file
    const torrentPath = path.join(LIBRARY_PATH, `${item.hash}.torrent`);
    fs.writeFileSync(torrentPath, torrent.torrentFile);
    item.filename = `${item.hash}.torrent`;

    updateItemInCollection(item);

    console.log(`Torrent completed for hash=${item.hash}, title="${item.title}"`);
    torrent.destroy(() => {
      console.log(`Destroyed torrent instance for hash=${item.hash}`);
    });

    // After finishing, we can try to start any queued items
    tryStartQueuedItems();
  });

  // On error => increment attempts, maybe fail if > 10
  torrent.once('error', err => {
    console.log(`Torrent error for hash=${item.hash} => ${err.message}`);
    item.attempts++;
    if (item.attempts > 10) {
      item.status = 'failed';
      console.log(`Item => status=failed, title="${item.title}"`);
    }
    else {
      // keep it "wanted" or "snatched"? or do "queued"? up to you
      item.status = 'wanted';
    }
    updateItemInCollection(item);
    torrent.destroy(() => {
      console.log(`Destroyed torrent instance after error for hash=${item.hash}`);
    });
  });
}

// Attempt to start any queued items if we have capacity
function tryStartQueuedItems() {
  let coll = loadCollection();
  let activeCount = getActiveDownloadCount(coll);

  for (let i = 0; i < coll.length; i++) {
    let item = coll[i];
    if (item.status === 'queued' && item.hash) {
      if (activeCount < MAX_ACTIVE_TORRENTS) {
        console.log(`Starting queued item: "${item.title}"`);
        startTorrentDownload(item);
        coll[i].status = 'downloading';
        coll[i].progress = 0;
        activeCount++;
      }
    }
  }
  saveCollection(coll);
}

/*
 * processCollection => 4-hour cycle 
 */
async function processCollection() {
  let coll = loadCollection();

  const maxWantedPerCycle = 5;
  let wantedCount = 0;

  for (let i = 0; i < coll.length; i++) {
    let item = coll[i];
    if (!['wanted','snatched','queued','downloading','torrented'].includes(item.status)) continue;

    // if "completed" => check if file missing => processed
    if (item.status === 'completed') {
      const torrentFile = path.join(LIBRARY_PATH, item.filename || '');
      if (!fs.existsSync(torrentFile)) {
        item.status = 'processed';
        console.log(`Item with title="${item.title}" => status=processed (file missing).`);
      }
      coll[i] = item;
      continue;
    }

    // if "torrented"? or "downloading"? We'll skip. "downloading" is handled by the torrent code
    if (item.status === 'downloading') {
      continue;
    }

    // if item.status === 'wanted' && item.hash === ''
    if (item.status === 'wanted' && !item.hash) {
      if (wantedCount >= maxWantedPerCycle) continue;
      wantedCount++;
      try {
        const infoHash = await extractInfoHash(item.detailsUrl);
        if (!infoHash) {
          item.attempts++;
          if (item.attempts > 10) {
            item.status = 'failed';
          }
        } else {
          item.hash = infoHash;
          item.status = 'snatched';
        }
      } catch (err) {
        item.attempts++;
        if (item.attempts > 10) {
          item.status = 'failed';
        }
        console.log(`Error extracting infoHash: ${err.message}`);
      }
      coll[i] = item;
      saveCollection(coll);
    }

    // If item has a hash but status is 'wanted' or 'snatched'
    if ((item.status === 'wanted' || item.status === 'snatched') && item.hash) {
      // Check concurrency
      const activeCount = getActiveDownloadCount(coll);
      if (activeCount >= MAX_ACTIVE_TORRENTS) {
        item.status = 'queued';
        coll[i] = item;
        console.log(`Item => queued. Title="${item.title}"`);
      } else {
        // Start the torrent
        startTorrentDownload(item);
        item.status = 'downloading';
        item.progress = 0.0;
        coll[i] = item;
        console.log(`Item => now downloading. Title="${item.title}"`);
      }
      saveCollection(coll);
    }
  }

  // If any items are 'completed' => check if missing => 'processed' (we did that above)
  // Done
  saveCollection(coll);
}

// Start queued items if there's capacity
// (we call this after finishing a torrent, or you can call after processCollection)
function resumeActiveTorrents() {
  let coll = loadCollection();
  // any item with status='downloading' => re-add torrent
  // any item with status='queued' => maybe we can start if there's capacity
  let activeCount = getActiveDownloadCount(coll);

  for (let i = 0; i < coll.length; i++) {
    let item = coll[i];
    if (item.status === 'downloading') {
      // re-add the torrent
      if (item.hash) {
        console.log(`Resuming torrent for hash=${item.hash}, title="${item.title}"`);
        startTorrentDownload(item);
      } else {
        // no hash => can't resume, keep it wanted or something
        item.status = 'wanted';
      }
    }
  }
  saveCollection(coll);
  // after that, try queued items
  tryStartQueuedItems();
}

cron.schedule('*/10 * * * *', () => {
  console.log('Running collection processing every 10 minutes...');
  processCollection();
});


/* --- Left Sidebar Data (Daily) --- */
const dbFilePath = path.join(__dirname, 'db', 'leftSidebarLinks.json');
function loadLeftSidebarData() {
  try {
    return JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveLeftSidebarData(data) {
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2));
}
async function scrapeLeftSidebar() {
  for (const base of baseUrls) {
    try {
      const url = base;
      const response = await axios.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 5000,
      });
      const $ = cheerio.load(response.data);
      const sidebarElement = $('#lsidebar');
      if (sidebarElement.length) {
        let categories = [];
        let modifiers = [];
        sidebarElement.find('li.leftCat').each((i, elem) => {
          const sectionTitle = $(elem).find('h2').first().text().trim().toLowerCase();
          if (sectionTitle === 'category' || sectionTitle === 'category modifiers') {
            $(elem).find('ul li a').each((j, linkElem) => {
              const name = $(linkElem).text().trim();
              const href = $(linkElem).attr('href');
              if (sectionTitle === 'category') {
                categories.push({ name, href });
              } else if (sectionTitle === 'category modifiers') {
                modifiers.push({ name, href });
              }
            });
          }
        });
        const data = { categories, modifiers };
        saveLeftSidebarData(data);
        console.log(`Left sidebar data updated from base ${base}:`, data);
        return data;
      } else {
        console.error(`Sidebar element not found for base ${base}`);
      }
    } catch (error) {
      console.error(`Error scraping left sidebar from base ${base}: ${error.message}`);
    }
  }
  console.error('All base URLs failed to scrape left sidebar.');
  return { categories: [], modifiers: [] };
}
// daily
cron.schedule('0 0 * * *', () => {
  console.log('Running daily left sidebar scrape...');
  scrapeLeftSidebar();
});
scrapeLeftSidebar();
app.get('/lsidebar', requireAuth, (req, res) => {
  const data = loadLeftSidebarData();
  res.json(data);
});

/* --- New Books Data (2-hour) --- */
const newBooksFilePath = path.join(__dirname, 'db', 'newBooks.json');
function loadNewBooksData() {
  try {
    return JSON.parse(fs.readFileSync(newBooksFilePath, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveNewBooksData(data) {
  fs.writeFileSync(newBooksFilePath, JSON.stringify(data, null, 2));
}
async function updateNewBooks() {
  try {
    const results = await searchAudiobooks("", true);
    saveNewBooksData(results);
    console.log('New books data updated:', results);
  } catch (error) {
    console.error('Error updating new books data:', error.message);
  }
}
// 2 hours
cron.schedule('0 */2 * * *', () => {
  console.log('Running new books update...');
  updateNewBooks();
});
updateNewBooks();
app.get('/newbooks', requireAuth, (req, res) => {
  const data = loadNewBooksData();
  res.json(data);
});


// GET /settings => returns the current settings as JSON
app.get('/settings', requireAuth, (req, res) => {
  const current = loadSettings();
  if (!current) {
    return res.status(500).json({ error: "Failed to load settings." });
  }
  res.json(current);
});

// POST /settings => replaces settings with the request body
app.post('/settings', requireAuth, (req, res) => {
  // The request body should contain all the needed fields
  const newSettings = req.body;

  // Optionally validate required fields if you want
  // e.g. if(!newSettings.username || !newSettings.password) { ... }

  // Save the new settings
  saveSettings(newSettings);
  reloadSettings();

  console.log("Settings updated:", newSettings);
  res.json({ message: "Settings saved successfully." });
});



app.post('/restart', (req, res) => {
  res.json({ message: "Server is restarting..." });
  setTimeout(() => {
    process.exit(0); 
  }, 300);
});



// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
