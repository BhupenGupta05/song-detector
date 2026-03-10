// Run script with: node song-detector.js
// Loads dotenv for RAPIDAPI_KEY
// Get current audio input device via SwitchAudioSource
// Switch input to Blackhole 2ch
// Wait for 1.5s for CoreAudio to settle
// Wait for user to press any key (play music now)
// Record 7s raw PCM audio via ffmeg
// Log file size and confirm creation
// Reac PCM file, encode to base64
// POST base64 data to RapidAPI Shazam /songs/detect via axios
// Receive JSON response from API
// Response has matches 
// If YES -> Parse & print title, artist, album, link
// If NO -> Print "No match found.
// Switch back to original input device
// Optional: delete recorded PCM file
// Exit process

require('dotenv').config();
const chalk = require('chalk');
const { execSync, exec } = require('child_process');
const axios = require('axios');
const { fetchLyrics } = require('./genius')

// === RapidAPI credentials ===
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'shazam.p.rapidapi.com';

// === Youtube credentials ===
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// === Circular Buffer Settings ===
const SAMPLE_RATE = 44100;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
const BUFFER_SECONDS = 4;
const BLACKHOLE_NAME = 'BlackHole 2ch';

// Buffer size for 4 seconds of audio: sampleRate * channels * bytesPerSample * seconds
const BUFFER_SIZE =
  SAMPLE_RATE *
  CHANNELS *
  BYTES_PER_SAMPLE *
  BUFFER_SECONDS;


// Allocate memory for Buffer
let circularBuffer = Buffer.alloc(BUFFER_SIZE);
let writeOffset = 0;
let ffmpegProcess = null;


function now() {
  return Date.now();
}


function section(title) {
  console.log(
    chalk.bgBlack.white.bold(`\n  ${title}  \n`)
  );
}


// Get current input device (Runs synchronously to get the current mic/input device name. Exits if not installed)
function getCurrentInput() {
  try {
    return execSync('SwitchAudioSource -c -t input').toString().trim();
  } catch (e) {
    console.error('SwitchAudioSource not found. Install via brew install switchaudio-osx');
    process.exit(1);
  }
}

// Switch input to device
function switchInput(device) {
  try {
    execSync(`SwitchAudioSource -s "${device}" -t input`);
    console.log(`Input switched to: ${device}`);
  } catch (e) {
    console.error('Failed to switch input:', e.message);
  }
}


function getSnapshot() {
  const snapshot = Buffer.alloc(BUFFER_SIZE);

  const endPart = circularBuffer.subarray(writeOffset);
  const startPart = circularBuffer.subarray(0, writeOffset);

  endPart.copy(snapshot, 0);
  startPart.copy(snapshot, endPart.length);

  return snapshot;
}

function writeChunkToCircularBuffer(chunk) {
  let remaining = chunk.length;
  let chunkOffset = 0;

  while (remaining > 0) {
    const spaceUntilEnd = BUFFER_SIZE - writeOffset;
    const bytesToWrite = Math.min(spaceUntilEnd, remaining);

    chunk.copy(
      circularBuffer,
      writeOffset,
      chunkOffset,
      chunkOffset + bytesToWrite
    );

    writeOffset = (writeOffset + bytesToWrite) % BUFFER_SIZE;
    chunkOffset += bytesToWrite;
    remaining -= bytesToWrite;
  }
}


// Captures last 4 seconds of audio by continuously writing to a circular buffer. 
// Uses ffmpeg to capture raw PCM audio from default input device (BlackHole). 
// Listens to stdout data events and writes incoming audio chunks to the circular buffer. 
// When getSnapshot() is called, it returns a Buffer containing the most recent 4 seconds of audio data in correct order, ready for processing or API submission.
function startContinuousRecording(duration) {

  const cmd = `
    ffmpeg -f avfoundation
    -i ":0"
    -ac 1
    -ar 44100
    -acodec pcm_s16le
    -f s16le
    -loglevel quiet
    pipe:1
  `.replace(/\s+/g, ' ');

  ffmpegProcess = exec(cmd, { encoding: 'buffer', maxBuffer: 50 * 1024 * 1024 })

  ffmpegProcess.stdout.on('data', (chunk) => {
    writeChunkToCircularBuffer(chunk);
  })

  ffmpegProcess.on('error', (err) => {
    console.error("FFmpeg error: ", err);
  })
}


// Search for YouTube video
async function searchYouTubeVideo(title, artist) {
  try {
    const query = `${title} ${artist} official audio`;

    const response = await axios.get(
      'https://www.googleapis.com/youtube/v3/search',
      {
        params: {
          part: 'snippet',
          q: query,
          type: 'video',
          maxResults: 1,
          key: YOUTUBE_API_KEY
        }
      }
    );

    const video = response.data.items[0];
    if (!video) return null;

    // console.log('\n🎬 YouTube Match:');
    // console.log(`${video.snippet.title}`);
    // console.log(`Channel: ${video.snippet.channelTitle}`);
    // console.log(`Link: https://www.youtube.com/watch?v=${video.id.videoId}`);

    section("🎬 YOUTUBE MATCH");

    console.log(chalk.yellow(video.snippet.title));
    console.log(chalk.gray(`Channel: ${video.snippet.channelTitle}`));
    console.log(chalk.blue(`https://www.youtube.com/watch?v=${video.id.videoId}`));


    return video.id.videoId;

  } catch (err) {
    console.error('YouTube search failed:', err.response?.data || err.message);
    return null;
  }
}

// Get recommendations from same channel by fetching more videos from the original video's channel and listing top 5 (excluding original)
async function getYouTubeRecommendations(videoId) {
  try {
    // Step 1: Get original video's channel
    const videoResponse = await axios.get(
      'https://www.googleapis.com/youtube/v3/videos',
      {
        params: {
          part: 'snippet',
          id: videoId,
          key: YOUTUBE_API_KEY
        }
      }
    );

    const video = videoResponse.data.items[0];
    if (!video) return;

    const channelId = video.snippet.channelId;

    // Step 2: Fetch more videos from same channel
    const response = await axios.get(
      'https://www.googleapis.com/youtube/v3/search',
      {
        params: {
          part: 'snippet',
          channelId: channelId,
          type: 'video',
          maxResults: 6,
          order: 'viewCount',
          key: YOUTUBE_API_KEY
        }
      }
    );

    // console.log('\n=== 🎵 Recommended Songs (Same Artist Channel) ===\n');
    section("🎵 RECOMMENDED SONGS");


    response.data.items
      .filter(item => item.id.videoId !== videoId)
      .slice(0, 5)
      .forEach((item, index) => {
        // console.log(`${index + 1}. ${item.snippet.title}`);
        // console.log(`   https://www.youtube.com/watch?v=${item.id.videoId}`);
        // console.log('---');
        console.log(chalk.green(`${index + 1}. ${item.snippet.title}`));
        console.log(chalk.blue(`   https://www.youtube.com/watch?v=${item.id.videoId}`));
        console.log(chalk.gray('---'));

      });

  } catch (err) {
    console.error('YouTube recommendation failed:', err.response?.data || err.message);
  }
}



// Reads file as buffer, converts to base64 string (inflates raw size by 33%)
// POST request to RapidAPI with base64 audio in body
// Then get recommendations for the same on Youtube
// Fetch lyrics from Genius parallelly while fetching YouTube data to save time. Log timings for each step.
async function recognizeWithRapidAPI(audioBuffer) {
  const base64Audio = audioBuffer.toString('base64');

  try {

    const shazamStart = now();
    const response = await axios({
      method: 'POST',
      url: 'https://shazam.p.rapidapi.com/songs/detect',
      headers: {
        'content-type': 'text/plain',
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST
      },
      data: base64Audio
    });

    // console.log("Shazam time:", now() - shazamStart, "ms");
    console.log(
      chalk.magenta("Shazam time: ") +
      chalk.white(`${now() - shazamStart} ms`)
    );



    let detectedTrack = null;

    if (response.data.matches?.length > 0) {
      detectedTrack = response.data.track || response.data.matches[0].track;
      // console.log('\n=== Song Detected ===');
      // console.log(`Title:  ${detectedTrack.title || 'Unknown'}`);
      // console.log(`Artist: ${detectedTrack.subtitle || detectedTrack.artists?.[0]?.alias || 'Unknown'}`);
      // console.log(`Album:  ${detectedTrack.sections?.[0]?.metadata?.[0]?.text || 'N/A'}`);
      // if (detectedTrack.share?.href) console.log(`Link:   ${detectedTrack.share.href}`);


      section("🎵 SONG DETECTED");

      console.log(chalk.yellow.bold(detectedTrack.title || 'Unknown'));
      console.log(chalk.gray(`by ${detectedTrack.subtitle || detectedTrack.artists?.[0]?.alias || 'Unknown'}`));

      console.log(
        chalk.white(`Album: `) +
        chalk.cyan(detectedTrack.sections?.[0]?.metadata?.[0]?.text || 'N/A')
      );

      if (detectedTrack.share?.href) {
        console.log(chalk.blue.underline(detectedTrack.share.href));
      }


      // =============================
      // 🚀 PARALLEL FETCHING
      // =============================

      console.log("\n" + chalk.gray("Analyzing song data...\n"));

      const lyricsStart = now();
      const ytStart = now();

      // Start both requests at the same time
      const lyricsPromise = fetchLyrics(
        detectedTrack.title,
        detectedTrack.subtitle,
        ""
      );

      const youtubeFlowPromise = (async () => {
        const youtubeVideoId = await searchYouTubeVideo(
          detectedTrack.title,
          detectedTrack.subtitle
        );

        console.log(
          chalk.magenta("YouTube search time: ") +
          chalk.white(`${now() - ytStart} ms`)
        );

        if (youtubeVideoId) {
          await getYouTubeRecommendations(youtubeVideoId);
        }
      })();

      // Await lyrics separately so we can print them when ready
      const lyrics = await lyricsPromise;

      console.log(
        chalk.magenta("Lyrics fetch time: ") +
        chalk.white(`${now() - lyricsStart} ms`)
      );

      if (lyrics) {
        section("🎶 LYRICS");
        console.log(chalk.white(lyrics));
        console.log(chalk.gray("\n────────────────────────────\n"));
      } else {
        console.log(chalk.red("Lyrics not found on Genius."));
      }

      // Wait for YouTube flow to complete (if still running)
      await youtubeFlowPromise;




      // // GENIUS LYRICS
      // console.log("\n🎤 Fetching lyrics from Genius...");

      // const lyricsStart = now();

      // const lyrics = await fetchLyrics(
      //   detectedTrack.title,
      //   detectedTrack.subtitle
      // );

      // console.log("Lyrics fetch time:", now() - lyricsStart, "ms");

      // if (lyrics) {
      //   // console.log("\n===============================");
      //   // console.log("🎶 LYRICS");
      //   // console.log("===============================\n");
      //   // console.log(lyrics);
      //   // console.log("\n===============================\n");
      //   section("🎶 LYRICS");

      //   console.log(chalk.white(lyrics));
      //   console.log(chalk.gray("\n────────────────────────────\n"));

      // }
      // else {
      //   // console.log("Lyrics not found on Genius.");
      //   console.log(chalk.red("Lyrics not found on Genius."));

      // }

      // // 


      // const youtubePromise = (async () => {
      //   const ytStart = now();
      //   const youtubeVideoId = await searchYouTubeVideo(
      //     detectedTrack.title,
      //     detectedTrack.subtitle
      //   );

      //   console.log("YouTube search time:", now() - ytStart, "ms");

      //   if (youtubeVideoId) {
      //     await getYouTubeRecommendations(youtubeVideoId);
      //   }
      // })();

      // await youtubePromise;




    } else {
      console.log('No match found.');
      console.log('Possible reasons: audio too quiet/noisy, song not in database, or clip issues.');
    }

    return detectedTrack;
  } catch (error) {
    console.error('RapidAPI error:', error.response?.data || error.message);
    if (error.response?.status === 406) {
      console.error('406 → Wrong format (must be raw PCM mono 44100 Hz 16-bit)');
    }
  }
}


// Wait for user to press key
function waitForKeypress() {
  return new Promise(resolve => {
    process.stdout.write('Press ANY key to start recording (play music now)... ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log('\nRecording...');
      resolve();
    });
  });
}


async function main() {
  const originalInput = getCurrentInput();

  try {
    const switchStart = now();
    switchInput(BLACKHOLE_NAME);
    console.log("Switch time:", now() - switchStart, "ms");

    console.log("Starting continuous recording...");
    startContinuousRecording();

    // Let buffer warm up
    console.log("Warming up buffer...");
    await new Promise(resolve => setTimeout(resolve, BUFFER_SECONDS * 1000));

    await waitForKeypress();

    console.log("Capturing last 4 seconds instantly...");
    const totalStart = now();

    const audioBuffer = getSnapshot();

    const apiStart = now();
    await recognizeWithRapidAPI(audioBuffer);
    console.log("API time:", now() - apiStart, "ms");

    console.log("TOTAL:", now() - totalStart, "ms");

  } finally {
    if (ffmpegProcess) {
      ffmpegProcess.kill('SIGINT');
    }
    switchInput(originalInput);
    process.exit(0);
  }
}


main();