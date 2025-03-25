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

// WebTorrent client
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

// Middleware
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

// Basic routes for login
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

// Serve main index.html
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Global variables from .env
const baseUrls = process.env.BASE_URLS
  ? process.env.BASE_URLS.split(',').map(url => url.trim())
  : [];
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/absolute/path/to/library';

// concurrency limit for certain tasks
const limitRequests = pLimit(5);

// Global axios defaults
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Helper function for delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Encodes a search query
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
          timeout: 750,
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

// parseAudiobookSearchResults
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

// getTotalPages
function getTotalPages(html) {
  const $ = cheerio.load(html);
  const lastPageLink = $('div.wp-pagenavi a[title="»»"]').attr('href');
  if (lastPageLink) {
    const match = lastPageLink.match(/\/page\/(\d+)\//);
    if (match && match[1]) return parseInt(match[1]);
  }
  return 1;
}

// searchAudiobooks
async function searchAudiobooks(query, browse = false) {
  const encodedQuery = browse ? query : encodeSearchQuery(query);
  const searchPath = browse ? query : `/?s=${encodedQuery}&cat=undefined%2Cundefined`;
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

// GET /search
app.get('/search', requireAuth, async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).send('Query parameter "q" is required');
  const results = await searchAudiobooks(query);
  res.json(results);
});

// GET /browse
app.get('/browse', requireAuth, async (req, res) => {
  const query = req.query.p;
  if (!query) return res.status(400).send('Browse location does not exist');
  const results = await searchAudiobooks(query, true);
  res.json(results);
});

/* 
 * Helper: attempts to fetch the Info Hash from the details page 
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
 * The new approach: /download route simply stores the item(s) in a "collection.json" 
 * with status: "wanted", hash: "", filename: "", attempts: 0
 */
const collectionFilePath = path.join(__dirname, 'db', 'collection.json');

// load the entire collection from the flat file
function loadCollection() {
  try {
    return JSON.parse(fs.readFileSync(collectionFilePath, 'utf8'));
  } catch (err) {
    return [];
  }
}

// save the entire collection to the flat file
function saveCollection(collection) {
  fs.writeFileSync(collectionFilePath, JSON.stringify(collection, null, 2));
}

// POST /download => just store the item(s) in the collection
// POST /download => store each (detailsUrl, title) in collection.json
app.post('/download', requireAuth, async (req, res) => {
  const { detailsUrls = [], titles = [] } = req.body;

  // If no detailsUrls were provided, return early
  if (!detailsUrls.length) {
    return res.json({ message: 'No detailsUrls provided', status: 'ok' });
  }

  // Load existing collection
  const collection = loadCollection();

  // For each detailsUrl, find the matching title by index
  for (let i = 0; i < detailsUrls.length; i++) {
    const url = detailsUrls[i];
    const thisTitle = titles[i] || 'Unknown Title';

    const newObj = {
      title: thisTitle,
      detailsUrl: url,
      status: 'wanted',
      hash: '',
      filename: '',
      attempts: 0
    };
    collection.push(newObj);
  }

  // Save the updated collection
  saveCollection(collection);

  console.log(`Added ${detailsUrls.length} item(s) to collection with status "wanted".`);

  // Return a success response
  res.json({ message: 'Added to collection', count: detailsUrls.length });
});


/*
 * We'll keep the SSE-based logs for the old approach, or we can repurpose them. 
 * For now, let's leave them as is, or remove them if not needed. 
 * We'll keep them for future expansions. 
*/

// SSE endpoint for live download logs (still used by older approach if needed)
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
 * Timed process every 4 hours to cycle through collection.json 
 * and attempt to gather infoHash or create .torrent for items with 
 * status in ["wanted","snatched"]. 
 * We'll define a limit for scraping (like 5 items?), but no limit for 
 * items that already have a hash. 
 * We also check if "torrented" items are missing their .torrent file => "processed"
 */

async function processCollection() {
  let collection = loadCollection();

  // We'll define a maximum number of wanted items to process per cycle to avoid rate-limit
  const maxWantedPerCycle = 5;
  let wantedCount = 0;

  for (const item of collection) {
    // skip if status not in ["wanted","snatched","torrented"]
    if (!['wanted', 'snatched', 'torrented'].includes(item.status)) continue;

    // If "torrented", check if .torrent file is missing => "processed"
    if (item.status === 'torrented') {
      const torrentFile = path.join(LIBRARY_PATH, item.filename || '');
      if (!fs.existsSync(torrentFile)) {
        // file missing => processed
        item.status = 'processed';
        console.log(`Item with title "${item.title}" => status set to processed (file missing).`);
      }
      continue;
    }

    // If item.status === "wanted" but item.hash === ""
    // => we need to scrape the details page for the info hash
    // => but we only do that if we haven't hit the limit
    if (item.status === 'wanted' && !item.hash) {
      if (wantedCount >= maxWantedPerCycle) {
        continue;
      }
      wantedCount++;

      // Attempt to get info hash
      try {
        const infoHash = await extractInfoHash(item.detailsUrl);
        if (!infoHash) {
          item.attempts++;
          if (item.attempts > 10) {
            item.status = 'failed';
            console.log(`Wanted item exceeded attempts => status=failed. Title="${item.title}"`);
          } else {
            console.log(`Wanted item: no hash found, attempts incremented. Title="${item.title}"`);
          }
        } else {
          item.hash = infoHash;
          item.status = 'snatched';
          console.log(`Item => "snatched" with hash=${infoHash}. Title="${item.title}"`);
        }
      } catch (err) {
        item.attempts++;
        if (item.attempts > 10) {
          item.status = 'failed';
          console.log(`Wanted item exception => status=failed. Title="${item.title}" err=${err.message}`);
        } else {
          console.log(`Wanted item exception => attempts++. Title="${item.title}" err=${err.message}`);
        }
      }
    }

    // If status is "wanted" but hash != "", or status is "snatched"
    // => attempt to create torrent file
    if (['wanted', 'snatched'].includes(item.status) && item.hash) {
      try {
        const magnet = `magnet:?xt=urn:btih:${item.hash}`;
        const torrentPath = path.join(LIBRARY_PATH, `${item.hash}.torrent`);

        // fetch metadata
        const torrent = client.add(magnet, { path: LIBRARY_PATH });
        await fetchMetadataOrTimeout(torrent, TORRENT_TIMEOUT);

        fs.writeFileSync(torrentPath, torrent.torrentFile);
        item.filename = `${item.hash}.torrent`;
        item.status = 'torrented';
        console.log(`Item => torrented. Title="${item.title}" torrentFile=${item.filename}`);

        torrent.destroy();
      } catch (err) {
        item.attempts++;
        if (item.attempts > 10) {
          item.status = 'failed';
          console.log(`Torrent creation exceeded attempts => status=failed. Title="${item.title}"`);
        } else {
          console.log(`Torrent creation error => attempts++. Title="${item.title}" err=${err.message}`);
        }
      }
    }
  }

  // save updated collection
  saveCollection(collection);
}



/* --- New Persistence for Left Sidebar Data --- */

// Define the path for the flat file database
const dbFilePath = path.join(__dirname, 'db', 'leftSidebarLinks.json');

// Load sidebar data from the flat file
function loadLeftSidebarData() {
  try {
    return JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

// Save sidebar data to the flat file
function saveLeftSidebarData(data) {
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2));
}

// Function to scrape the left sidebar from the source home page using baseUrls
async function scrapeLeftSidebar() {
  for (const base of baseUrls) {
    try {
      // Construct the URL using the current base (assumed to be the home page)
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
        // Loop through each section marked by li.leftCat
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




// Schedule the left sidebar scraping to run daily at midnight
cron.schedule('0 0 * * *', () => {
  console.log('Running daily left sidebar scrape...');
  scrapeLeftSidebar();
});

// Initial scrape on server start
scrapeLeftSidebar();

// New route to serve the left sidebar data
app.get('/lsidebar', requireAuth, (req, res) => {
  const data = loadLeftSidebarData();
  res.json(data);
});


/* --- New Persistence for New Books Data --- */

// Define the path for the new books JSON file
const newBooksFilePath = path.join(__dirname, 'db', 'newBooks.json');

// Load new books data from the flat file
function loadNewBooksData() {
  try {
    return JSON.parse(fs.readFileSync(newBooksFilePath, 'utf8'));
  } catch (e) {
    return [];
  }
}

// Save new books data to the flat file
function saveNewBooksData(data) {
  fs.writeFileSync(newBooksFilePath, JSON.stringify(data, null, 2));
}

// Function to update new books by scraping the homepage (newest books)
// We call searchAudiobooks with an empty query ("") and browse = true.
async function updateNewBooks() {
  try {
    const results = await searchAudiobooks("", true);
    saveNewBooksData(results);
    console.log('New books data updated:', results);
  } catch (error) {
    console.error('Error updating new books data:', error.message);
  }
}

// Schedule the updateNewBooks function to run every 2 hours.
cron.schedule('0 */2 * * *', () => {
  console.log('Running new books update...');
  updateNewBooks();
});

// Initial update on server start.
updateNewBooks();

// New route to serve new books data.
app.get('/newbooks', requireAuth, (req, res) => {
  const data = loadNewBooksData();
  res.json(data);
});



// Schedule processCollection every 4 hours
cron.schedule('0 */4 * * *', () => {
  console.log('Running 4-hour collection processing...');
  processCollection();
});

// Start the server.
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
