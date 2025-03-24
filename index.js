require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const path = require('path');
const https = require('https');
const http = require('http');
const Bottleneck = require('bottleneck');

const app = express();
const port = 3000;

// Create a Bottleneck limiter to allow 50 requests per 300 seconds.
const limiter = new Bottleneck({
  reservoir: 50,                      // initial number of requests
  reservoirRefreshAmount: 50,         // number of requests to restore
  reservoirRefreshInterval: 300000,   // refresh every 300,000 ms (300 sec)
  maxConcurrent: 1,                   // only 1 concurrent request
});

// Serve the index.html file at the root route.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fixed base URLs from .env.
const baseUrls = process.env.BASE_URLS
  ? process.env.BASE_URLS.split(',').map(url => url.trim())
  : [];

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
 * Helper to encode the search query.
 * This replaces spaces with plus signs.
 * @param {string} query - The raw search query.
 * @returns {string} - The encoded query.
 */
function encodeSearchQuery(query) {
  return encodeURIComponent(query).replace(/%20/g, '+');
}

/**
 * Attempts to fetch a URL by cycling through the fixed base URLs.
 * For each base, it will try up to 3 attempts with delays.
 * Each axios request is scheduled through the Bottleneck limiter.
 * @param {string} path - The path and query to append to the base URL.
 * @returns {Promise<Object>} - An object with { data, baseUsed }.
 */
async function fetchWithBaseUrls(path) {
  for (const base of baseUrls) {
    const fullUrl = path.startsWith('http') ? path : `${base}${path}`;
    const maxAttempts = 3;
    let attempts = 0;
    while (attempts < maxAttempts) {
      try {
        const response = await limiter.schedule(() =>
          axios.get(fullUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 15000,
          })
        );
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
 * Fetches the torrent link from the audiobook details page.
 * For now this function is not used, since we delay fetching the torrent URL until download.
 * It is retained here for future use.
 * @param {string} detailsUrl - URL (or path) of the audiobook details page.
 * @returns {Promise<string|null>} - The torrent link if found, otherwise null.
 */
async function getTorrentLinkFromDetailsPage(detailsUrl) {
  const maxAttempts = 3;
  let attempts = 0;
  while (attempts < maxAttempts) {
    try {
      const response = await limiter.schedule(() =>
        axios.get(detailsUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          timeout: 15000,
        })
      );
      await sleep(2000);
      const $ = cheerio.load(response.data);
      let torrentLink = $('a:contains("Torrent Free Downloads")').attr('href');
      if (torrentLink) return torrentLink;
    } catch (error) {
      attempts++;
      console.error(`Error fetching details page ${detailsUrl} on attempt ${attempts}: ${error.message}`);
      await sleep(2000);
    }
  }
  return null;
}

/**
 * Parses the search results page HTML and extracts audiobook details.
 * It extracts title, details URL, metadata, and image URL.
 * @param {string} html - Raw HTML from a search results page.
 * @returns {Promise<Array>} - Array of audiobook objects.
 */
async function parseAudiobookSearchResults(html) {
  const $ = cheerio.load(html);
  const posts = $('div.post').toArray();
  const results = await Promise.all(
    posts.map(elem =>
      limitRequests(async () => {
        const titleElem = $(elem).find('div.postTitle h2 a');
        const title = titleElem.text().trim();
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
 * @param {string} html - HTML content of the search results page.
 * @returns {number} - Total number of pages found (default: 1).
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
 * Searches for audiobooks and handles pagination (limited to the first 5 pages).
 * The search path is built using the encoded search query.
 * @param {string} query - The search term.
 * @returns {Promise<Array>} - Combined results from all pages.
 */
async function searchAudiobooks(query) {
  const encodedQuery = encodeSearchQuery(query);
  // Build the search path; we include the cat parameter to mimic browser behavior.
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

// Start the server.
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
