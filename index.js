require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const pLimit = require('p-limit');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const port = 3000;

// Serve the index.html file at the root route.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Fixed base URLs from .env (make sure they do not include any extra query parameters)
const baseUrls = process.env.BASE_URLS
  ? process.env.BASE_URLS.split(',').map(url => url.trim())
  : [];

// Use a strict concurrency limit (only 1 request at a time)
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
 * Attempts to fetch a URL by cycling through the fixed base URLs.
 * For each base URL, it will try up to 3 attempts with delays.
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
 * The search string is built using only the "s" parameter.
 * @param {string} query - The search term.
 * @returns {Promise<Array>} - Combined results from all pages.
 */
async function searchAudiobooks(query) {
  // Build the search path using only the "s" parameter.
  const searchPath = `/?s=${encodeURIComponent(query)}`;
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
        const pagePath = `/page/${page}/?s=${encodeURIComponent(query)}`;
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
