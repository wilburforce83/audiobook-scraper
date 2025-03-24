require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const port = 3000;

// Middleware to parse JSON request bodies
app.use(express.json());

// Serve the index.html file at the root route.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fixed base URLs from .env.
const baseUrls = process.env.BASE_URLS
  ? process.env.BASE_URLS.split(',').map(url => url.trim())
  : [];

// The absolute path where torrent files will be saved.
// Make sure LIBRARY_PATH is defined in your .env file.
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/absolute/path/to/library';

// Use a strict concurrency limit (only 1 task at a time).
const limitRequests = pLimit(1);

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
          timeout: 15000,
        });
        console.log(`Successfully fetched from base: ${base} on attempt ${attempts + 1}`);
        return { data: response.data, baseUsed: base };
      } catch (error) {
        attempts++;
        console.error(`Error fetching from ${base} on attempt ${attempts}: ${error.message}`);
        await sleep(2000);
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
        await sleep(1000);
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
    await sleep(2000);
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
              await sleep(2000);
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
app.get('/search', async (req, res) => {
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
          timeout: 15000,
        });
        await sleep(2000);
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
        await sleep(2000);
      }
    }
    return null;
  }
  

/**
 * POST /download route.
 * Expects a JSON body with a property "detailsUrls" which is an array of details page URLs.
 * For each URL, retrieves the torrent URL and downloads the torrent file to LIBRARY_PATH.
 */
app.post('/download', async (req, res) => {
  const detailsUrls = req.body.detailsUrls;
  if (!detailsUrls || !Array.isArray(detailsUrls) || !detailsUrls.length) {
    return res.status(400).send('Request body must contain a "detailsUrls" array with at least one URL.');
  }
  
  const results = [];
  
  for (const url of detailsUrls) {
    try {
      const torrentUrl = await getTorrentLinkFromDetailsPage(url);
      if (!torrentUrl) {
        results.push({ detailsUrl: url, status: 'failed', error: 'Torrent URL not found' });
        continue;
      }
      
      // Download torrent file (as arraybuffer)
      const torrentResponse = await axios.get(torrentUrl, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        timeout: 3000,
      });
      
      // Create a filename using current timestamp and index (or derive from URL)
      const filename = 'download_' + Date.now() + '_' + Math.floor(Math.random()*1000) + '.torrent';
      const filepath = path.join(LIBRARY_PATH, filename);
      
      fs.writeFileSync(filepath, torrentResponse.data);
      console.log(`Downloaded torrent from ${torrentUrl} to ${filepath}`);
      results.push({ detailsUrl: url, torrentUrl, filepath, status: 'success' });
    } catch (error) {
      console.error(`Error downloading torrent for ${url}: ${error.message}`);
      results.push({ detailsUrl: url, status: 'failed', error: error.message });
    }
  }
  
  res.json(results);
});

// Start the server.
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
