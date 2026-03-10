const axios = require("axios");
const cheerio = require("cheerio");

const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function extractPrimaryArtist(artist) {
  return artist.split("&")[0].split(",")[0].trim();
}

function cleanTitle(title) {
  return title
    .replace(/\(from.*?\)/gi, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/official|video|lyrics|remastered/gi, "")
    .trim();
}


function isConfidentMatch(foundTitle, originalTitle) {
  const aWords = normalize(foundTitle).split(" ");
  const bWords = normalize(originalTitle).split(" ");

  const overlap = bWords.filter(word => aWords.includes(word));

  return overlap.length >= Math.ceil(bWords.length * 0.6);
}


// 1️⃣ Search song on Genius

async function searchGenius(query, originalTitle) {
  const response = await axios.get(
    "https://api.genius.com/search",
    {
      headers: {
        Authorization: `Bearer ${GENIUS_TOKEN}`
      },
      params: { q: query }
    }
  );

  const hits = response.data.response.hits;
  if (!hits.length) return null;

  for (const hit of hits) {
    const geniusTitle = hit.result.title;
    const geniusArtist = hit.result.primary_artist.name;

    const titleMatch = isConfidentMatch(geniusTitle, originalTitle);

    if (titleMatch) {
      return hit.result.url;
    }
  }

  return null;
}


// 2️⃣ Scrape lyrics page
async function scrapeLyrics(url) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  let lyrics = "";

  $('div[data-lyrics-container="true"]').each((i, el) => {
    lyrics += $(el).html() + "<br>";
  });

  // Convert <br> to newline
  lyrics = lyrics.replace(/<br\s*\/?>/gi, "\n");

  // Remove remaining HTML tags
  lyrics = lyrics.replace(/<\/?[^>]+(>|$)/g, "");

  // Format section headers like [Verse 1]
  lyrics = lyrics.replace(/\[(.*?)\]/g, "\n\n=== $1 ===\n");

  // Fix Hindi/Unicode line merging
  lyrics = lyrics.replace(/([^\n])([A-Z])/g, "$1\n$2");

  // Remove excessive blank lines
  lyrics = lyrics.replace(/\n{3,}/g, "\n\n");

  return lyrics.trim();
}


// 3️⃣ Combined function
async function fetchLyrics(title, artist, youtubeTitle="") {
  console.log("Searching Genius for:", title, artist);
  const rawStrategies = [
    `${title} ${artist}`,
    `${title} ${extractPrimaryArtist(artist)}`,
    `${title}`,
    cleanTitle(title),
    youtubeTitle
  ];
  const strategies = [...new Set(rawStrategies.filter(Boolean))];
  for (const query of strategies) {
    console.log("Trying query:", query);
    const url = await searchGenius(query, title);
    if (url) {
      console.log("Matched using:", query);
      const lyrics = await scrapeLyrics(url);
      return lyrics;
    }
  }
  return null;
}

module.exports = { fetchLyrics };
