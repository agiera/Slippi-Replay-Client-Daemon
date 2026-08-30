const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { spawn, execFileSync } = require("child_process");

// Maximum wall-clock time to allow a single Dolphin render before giving up.
const DEFAULT_RENDER_TIMEOUT_MS = 20 * 60 * 1000;
// Ignore an early [NO_GAME] during Dolphin startup before the replay loads.
const NO_GAME_GRACE_MS = 5000;
// Wait for this many bytes of frame dump (header + a few frames) before ffmpeg
// opens the growing file, so it can probe the stream cleanly.
const DUMP_HEADER_BYTES = 256 * 1024;
// Fallback drain (only used when the replay length is unknown or Dolphin's dump
// ends a hair short of the -frames:v target): after Dolphin exits the dump is
// final, but ffmpeg may still be reading well behind the live edge (software
// Xvfb rendering runs below realtime). Keep the tails feeding until the encode
// catches up — its frame= progress plateaus for TAIL_DRAIN_PLATEAU_MS — rather
// than closing after a fixed delay, which truncated the tail whenever ffmpeg
// lagged. TAIL_DRAIN_MAX_MS bounds the wait so a stuck encode can't hang us.
const TAIL_DRAIN_PLATEAU_MS = 2000;
const TAIL_DRAIN_MAX_MS = 120000;
// If ffmpeg's encode progress (frame=) stops advancing for this long, the
// render is stuck: Dolphin keeps the AVI growing even when the game is over, so
// input file size is unreliable — the frozen encode is the real "stuck" signal.
const ENCODE_STALL_MS = 10000;
// Slippi replays begin at frame -123 (GAME_STARTUP_FRAMES), so the number of
// rendered frames is metadata.lastFrame + 123.
const REPLAY_START_FRAME_OFFSET = 123;
const VIDEO_EXTENSIONS = [".avi", ".mp4", ".mkv", ".mov"];
const AUDIO_EXTENSIONS = [".wav"];

function ensureConfigured(config) {
  if (!config.dolphinPath || !fs.existsSync(config.dolphinPath)) {
    throw new Error("Slippi playback Dolphin path is not configured or does not exist");
  }
  if (!config.meleeIsoPath || !fs.existsSync(config.meleeIsoPath)) {
    throw new Error("Melee ISO path is not configured or does not exist");
  }
}

function writeDolphinConfig(userDir) {
  const configDir = path.join(userDir, "Config");
  fs.mkdirSync(configDir, { recursive: true });

  const dolphinIni = [
    "[Core]",
    "EnableCheats = False",
    "[Display]",
    "RenderToMain = True",
    "Fullscreen = False",
    "[Movie]",
    "DumpFrames = True",
    "DumpFramesSilent = True",
    "[DSP]",
    "DumpAudio = True",
    "DumpAudioSilent = True",
    "Backend = No audio output",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "Dolphin.ini"), dolphinIni);

  const gfxIni = [
    "[Settings]",
    "InternalResolutionFrameDumps = True",
    "EFBScale = 2",
    "BitrateKbps = 3000",
    "[Hardware]",
    "VSync = False",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(configDir, "GFX.ini"), gfxIni);
}

function writeCommFile(userDir, replayPath) {
  const commPath = path.join(userDir, "playback-comm.json");
  // Full Slippi playback schema: isRealTimeMode=false makes Dolphin dump as fast
  // as possible and quit once the queue is exhausted.
  const comm = {
    mode: "queue",
    replay: "",
    isRealTimeMode: false,
    outputOverlayFiles: false,
    queue: [{ path: replayPath, gameStartAt: "", gameStation: "" }],
  };
  fs.writeFileSync(commPath, JSON.stringify(comm));
  return commPath;
}

// Read metadata.lastFrame straight out of the .slp UBJSON trailer so the daemon
// knows the replay's length without a full parser. Returns null when it can't be
// determined (callers fall back to Dolphin's own [GAME_END_FRAME] detection).
function readReplayLastFrame(replayPath) {
  let data;
  try {
    data = fs.readFileSync(replayPath);
  } catch {
    return null;
  }
  // Metadata keys are UBJSON strings: <lengthMarker><len><bytes>. Search for the
  // "lastFrame" key with either a U (uint8) or i (int8) length marker.
  for (const lengthMarker of [0x55, 0x69]) {
    const needle = Buffer.concat([
      Buffer.from([lengthMarker, 0x09]),
      Buffer.from("lastFrame", "latin1"),
    ]);
    const keyPos = data.lastIndexOf(needle);
    if (keyPos < 0) continue;
    try {
      const [value] = parseUbjsonValue(data, keyPos + needle.length);
      if (Number.isInteger(value)) return value;
    } catch {
      // Fall through and try the other marker / give up.
    }
  }
  return null;
}

function parseUbjsonValue(data, start) {
  if (start >= data.length) throw new Error("missing value marker");
  const marker = data[start];
  switch (marker) {
    case 0x55: // U: uint8
      return [data[start + 1], start + 2];
    case 0x69: { // i: int8
      const raw = data[start + 1];
      return [raw > 127 ? raw - 256 : raw, start + 2];
    }
    case 0x49: // I: int16
      if (start + 3 > data.length) throw new Error("truncated int16");
      return [data.readInt16BE(start + 1), start + 3];
    case 0x6c: // l: int32
      if (start + 5 > data.length) throw new Error("truncated int32");
      return [data.readInt32BE(start + 1), start + 5];
    case 0x4c: // L: int64
      if (start + 9 > data.length) throw new Error("truncated int64");
      return [Number(data.readBigInt64BE(start + 1)), start + 9];
    default:
      throw new Error(`unsupported value marker: ${String.fromCharCode(marker)}`);
  }
}

function findNewestFileRecursive(dir, extensions) {
  if (!fs.existsSync(dir)) {
    return null;
  }
  let newest = null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findNewestFileRecursive(fullPath, extensions);
      if (nested && (!newest || nested.mtimeMs > newest.mtimeMs)) {
        newest = nested;
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!extensions.includes(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    const stat = fs.statSync(fullPath);
    if (!newest || stat.mtimeMs > newest.mtimeMs) {
      newest = { path: fullPath, mtimeMs: stat.mtimeMs };
    }
  }
  return newest;
}

function findNewestFile(dir, extensions) {
  const result = findNewestFileRecursive(dir, extensions);
  return result ? result.path : null;
}


// Resolves whether a command is runnable: an explicit path must exist, a bare
// name must be found on PATH.
function commandExists(command) {
  if (!command) return false;
  if (command.includes(path.sep)) return fs.existsSync(command);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => fs.existsSync(path.join(dir, command)));
}

// Builds the argv for launching Dolphin, optionally wrapped in xvfb-run so it
// renders on an isolated virtual display. Desktop compositors suspend GL
// rendering for windows on an inactive workspace, which starves the frame dump
// and freezes the live encode; a headless X server keeps Dolphin rendering
// regardless of which desktop is focused. `detached` is true for the wrapped
// case so the whole process group (xvfb-run -> Xvfb + Dolphin) can be signalled.
// Falls back to a normal windowed launch when xvfb-run isn't installed.
function resolveDolphinLaunch(config, dolphinArgs, onLog) {
  const windowed = { command: config.dolphinPath, args: dolphinArgs, detached: false };
  if (config.headless === false) {
    return windowed;
  }
  const xvfbRun = config.xvfbRunPath || "xvfb-run";
  if (!commandExists(xvfbRun)) {
    onLog?.(
      `Headless requested but ${xvfbRun} not found on PATH; launching Dolphin windowed. ` +
        "Install xvfb-run (Fedora: xorg-x11-server-Xvfb) so it isn't paused when off-screen."
    );
    return windowed;
  }
  const screen = config.xvfbScreen || "1920x1080x24";
  return {
    command: xvfbRun,
    args: ["-a", "-s", `-screen 0 ${screen}`, config.dolphinPath, ...dolphinArgs],
    detached: true,
  };
}

// Signals a child, targeting its whole process group when it was launched
// detached (e.g. via xvfb-run, which forks Xvfb + Dolphin) so no orphaned X
// server or emulator survives.
function signalChild(child, signal, killGroup) {
  try {
    if (killGroup && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function runProcess(command, args, { timeoutMs, signal, onLog, capture, stopWhen, detached = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached });
    let settled = false;
    let stopping = false;
    let stopKillTimer = null;

    const record = (text) => {
      onLog?.(text);
      if (capture) {
        capture.push(text);
        if (capture.length > 40) {
          capture.shift();
        }
      }
      if (!settled && !stopping && stopWhen && stopWhen(text)) {
        stopping = true;
        onLog?.(`Replay finished; closing ${path.basename(command)}`);
        // Give Dolphin a moment to flush the final frames before it exits.
        setTimeout(() => {
          signalChild(child, "SIGTERM", detached);
          stopKillTimer = setTimeout(() => signalChild(child, "SIGKILL", detached), 5000);
        }, 500);
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        onLog?.(`Killing ${path.basename(command)} after timeout`);
        signalChild(child, "SIGKILL", detached);
        reject(new Error(`${path.basename(command)} timed out`));
      }
    }, timeoutMs);

    const onAbort = () => {
      if (!settled) {
        signalChild(child, "SIGKILL", detached);
        reject(new Error("Render cancelled"));
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk) => record(chunk.toString().trim()));
    child.stderr.on("data", (chunk) => record(chunk.toString().trim()));


    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      if (stopKillTimer) clearTimeout(stopKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (stopKillTimer) clearTimeout(stopKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
      // A stop we requested (replay finished) is a normal, successful exit.
      if (stopping || code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`${path.basename(command)} exited with code ${code}`));
      }
    });
  });
}

// Runs Dolphin to dump the replay's raw video/audio into a fresh temp userDir.
// The caller owns the returned userDir and must remove it once the dumps have
// been fully consumed (e.g. after ffmpeg exits).
async function prepareDumps({ replayPath, config, onLog, signal }) {
  ensureConfigured(config);

  if (!fs.existsSync(replayPath)) {
    throw new Error(`Replay file not found: ${replayPath}`);
  }

  const timeoutMs = Number(config.renderTimeoutMs) || DEFAULT_RENDER_TIMEOUT_MS;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "slippi-render-"));

  try {
    writeDolphinConfig(userDir);
    const commPath = writeCommFile(userDir, replayPath);

    const dolphinArgs = [
      "-b",
      "-e",
      config.meleeIsoPath,
      "-i",
      commPath,
      "-u",
      userDir,
    ];

    onLog?.(`Launching Dolphin to render ${path.basename(replayPath)}`);
    const dolphinOutput = [];
    const dolphinStartedAt = Date.now();
    // Slippi playback Dolphin keeps dumping its idle "Waiting for game..." screen
    // after the replay ends. Close it once the game is over so the frame dump
    // stops: [GAME_END_FRAME] marks the final frame, [NO_GAME] means playback has
    // returned to the idle screen (grace-guarded so startup doesn't false-match).
    const stopWhen = (text) =>
      text.includes("[GAME_END_FRAME]") ||
      (text.includes("[NO_GAME]") && Date.now() - dolphinStartedAt > NO_GAME_GRACE_MS);
    const dolphinLaunch = resolveDolphinLaunch(config, dolphinArgs, onLog);
    await runProcess(dolphinLaunch.command, dolphinLaunch.args, {
      timeoutMs,
      signal,
      onLog,
      capture: dolphinOutput,
      stopWhen,
      detached: dolphinLaunch.detached,
    });
    const dolphinElapsedMs = Date.now() - dolphinStartedAt;

    const framesDir = path.join(userDir, "Dump", "Frames");
    const audioDir = path.join(userDir, "Dump", "Audio");
    const videoDump = findNewestFile(framesDir, VIDEO_EXTENSIONS) || findNewestFile(userDir, VIDEO_EXTENSIONS);
    const audioDump = findNewestFile(audioDir, AUDIO_EXTENSIONS) || findNewestFile(userDir, AUDIO_EXTENSIONS);

    if (!videoDump) {
      const tail = dolphinOutput.slice(-15).join("\n").trim();
      const hint =
        dolphinElapsedMs < 3000
          ? " Dolphin exited almost immediately; check the Playback Dolphin path/ISO and that it can open a window (needs a display)."
          : "";
      throw new Error(
        `Dolphin did not produce a frame dump (exited after ${dolphinElapsedMs}ms).${hint}` +
          (tail ? `\nDolphin output:\n${tail}` : " Dolphin produced no output.")
      );
    }

    return { userDir, videoDump, audioDump, timeoutMs };
  } catch (error) {
    fs.rm(userDir, { recursive: true, force: true }, () => {});
    throw error;
  }
}

function buildFfmpegArgs(videoDump, audioDump, tail, { maxVideoFrames } = {}) {
  const args = ["-y", "-i", videoDump];
  if (audioDump) {
    args.push("-i", audioDump);
  }
  args.push("-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p");
  if (audioDump) {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  }
  // Stop after exactly N video frames (the replay's true length from the slp
  // metadata) so the encode ends precisely at the game's end instead of racing
  // tail's drain of the still-growing live dump.
  if (maxVideoFrames != null) {
    args.push("-frames:v", String(maxVideoFrames));
  }
  args.push(...tail);
  return args;
}

async function renderReplayToMp4({ replayPath, outputPath, config, onLog, signal }) {
  const { userDir, videoDump, audioDump, timeoutMs } = await prepareDumps({ replayPath, config, onLog, signal });

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    // Relocate the moov atom to the front so a completed file streams
    // progressively (browser starts playback before the full download).
    const ffmpegArgs = buildFfmpegArgs(videoDump, audioDump, ["-movflags", "+faststart", outputPath]);

    onLog?.(`Encoding mp4 with ffmpeg for ${path.basename(replayPath)}`);
    await runProcess(config.ffmpegPath || "ffmpeg", ffmpegArgs, { timeoutMs, signal, onLog });

    if (!fs.existsSync(outputPath)) {
      throw new Error("ffmpeg did not produce an output file");
    }

    return outputPath;
  } finally {
    fs.rm(userDir, { recursive: true, force: true }, () => {});
  }
}

// Spawns ffmpeg with its encoded output on stdout. Returns the readable stdout
// stream plus a `done` promise that settles when the process exits.
function spawnFfmpegStream(command, args, { timeoutMs, signal, onLog, onProgress }) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stderrTail = [];

  const timer = setTimeout(() => {
    onLog?.(`Killing ${path.basename(command)} after timeout`);
    child.kill("SIGKILL");
  }, timeoutMs);

  const onAbort = () => child.kill("SIGKILL");
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    // ffmpeg's stderr (banner, per-frame progress, x264 summary) floods the log;
    // keep it out unless explicitly debugging, but still parse progress and
    // retain a tail for error reporting.
    if (process.env.RENDER_FFMPEG_DEBUG) onLog?.(text);
    const match = /frame=\s*(\d+)/.exec(text);
    if (match) onProgress?.(Number(match[1]));
    stderrTail.push(text);
    if (stderrTail.length > 40) {
      stderrTail.shift();
    }
  });

  const done = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (code === 0 || code === null) {
        resolve();
      } else {
        const tail = stderrTail.slice(-5).join("\n");
        reject(new Error(`${path.basename(command)} exited with code ${code}${tail ? `\n${tail}` : ""}`));
      }
    });
  });

  return { stream: child.stdout, done, kill: () => child.kill("SIGKILL") };
}

// Resolves after `ms`, rejecting early if the abort signal fires.
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Render cancelled"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

// Polls a Dump directory until Dolphin has written a file of the requested type
// that is at least `minSize` bytes (or Dolphin has exited). Returns the path, or
// null if Dolphin exited without producing one.
async function waitForDumpFile(dir, extensions, { signal, timeoutMs, minSize, dolphinExited }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error("Render cancelled");
    const found = findNewestFile(dir, extensions);
    if (found) {
      let size = 0;
      try {
        size = fs.statSync(found).size;
      } catch {
        size = 0;
      }
      if (size >= minSize || dolphinExited()) return found;
    } else if (dolphinExited()) {
      return null;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for a dump file in ${dir}`);
    await delay(200, signal);
  }
}

// Launches Dolphin to dump the replay but does NOT wait for it to finish, so the
// caller can start encoding while frames are still being written. Closes Dolphin
// once the game ends (same [GAME_END_FRAME]/[NO_GAME] detection as the file path).
function spawnDolphinDump({ userDir, commPath, config, onLog, signal, timeoutMs }) {
  const args = ["-b", "-e", config.meleeIsoPath, "-i", commPath, "-u", userDir];
  const launch = resolveDolphinLaunch(config, args, onLog);
  const child = spawn(launch.command, launch.args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: launch.detached,
  });
  const killGroup = launch.detached;
  const output = [];
  const startedAt = Date.now();
  let settled = false;
  let stopping = false;
  let stopKillTimer = null;

  const stopWhen = (text) =>
    text.includes("[GAME_END_FRAME]") ||
    (text.includes("[NO_GAME]") && Date.now() - startedAt > NO_GAME_GRACE_MS);

  // Gracefully quit Dolphin (SIGTERM, then SIGKILL as a backstop) so it flushes
  // the final dumped frames. Used both by [GAME_END_FRAME] detection and by the
  // caller once the encode has covered the whole replay duration.
  const beginStop = (reason) => {
    if (settled || stopping) return;
    stopping = true;
    onLog?.(reason || "Replay finished; closing dolphin");
    setTimeout(() => {
      signalChild(child, "SIGTERM", killGroup);
      stopKillTimer = setTimeout(() => signalChild(child, "SIGKILL", killGroup), 5000);
    }, 500);
  };

  const record = (text) => {
    onLog?.(text);
    output.push(text);
    if (output.length > 40) output.shift();
    if (!settled && !stopping && stopWhen(text)) {
      beginStop("Replay finished; closing dolphin");
    }
  };

  const timer = setTimeout(() => {
    if (!settled) signalChild(child, "SIGKILL", killGroup);
  }, timeoutMs);

  const onAbort = () => {
    if (!settled) signalChild(child, "SIGKILL", killGroup);
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  child.stdout.on("data", (chunk) => record(chunk.toString().trim()));
  child.stderr.on("data", (chunk) => record(chunk.toString().trim()));

  const done = new Promise((resolve, reject) => {
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      if (stopKillTimer) clearTimeout(stopKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (stopKillTimer) clearTimeout(stopKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
      if (stopping || code === 0 || code === null) resolve();
      else reject(new Error(`dolphin exited with code ${code}`));
    });
  });

  return {
    done,
    stop: (reason) => beginStop(reason),
    kill: () => signalChild(child, "SIGKILL", killGroup),
    getOutput: () => output.slice(),
    isSettled: () => settled,
  };
}

// Bridges a still-growing dump file into a FIFO with `tail -F` so ffmpeg reads it
// live. The FIFO is opened O_RDWR (Linux) so the open never blocks or races the
// reader; the parent closes its copy, leaving tail as the sole writer so ffmpeg
// sees EOF once tail is killed.
function spawnTail(sourceFile, fifoPath, onLog) {
  const fd = fs.openSync(fifoPath, fs.constants.O_RDWR);
  const child = spawn("tail", ["-s", "0.2", "-c", "+1", "-F", sourceFile], {
    stdio: ["ignore", fd, "pipe"],
  });
  fs.closeSync(fd);
  child.stderr.on("data", (chunk) => onLog?.(`tail: ${chunk.toString().trim()}`));
  child.on("error", (error) => onLog?.(`tail error: ${error.message}`));
  return child;
}

// Calls onStall once encode progress (reported via note()) has not advanced for
// `stallMs`. A frozen frame= is only a real stall if the input dump has ALSO
// stopped growing: while Dolphin keeps writing the AVI, a paused encode just
// means ffmpeg caught up to the live edge and is waiting for more frames.
function watchEncodeStall({ stallMs, signal, onStall, inputFile }) {
  let lastValue = -1;
  let lastProgressAt = Date.now();
  let lastInputSize = -1;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
  };
  const note = (value) => {
    if (value > lastValue) {
      lastValue = value;
      lastProgressAt = Date.now();
    }
  };
  const inputGrew = () => {
    if (!inputFile) return false;
    let size = -1;
    try {
      size = fs.statSync(inputFile).size;
    } catch {
      return false;
    }
    if (size > lastInputSize) {
      lastInputSize = size;
      return true;
    }
    return false;
  };
  const interval = setInterval(() => {
    if (signal?.aborted) {
      stop();
      return;
    }
    // Dolphin still dumping => ffmpeg is only waiting at the live edge, not stuck.
    if (inputGrew()) {
      lastProgressAt = Date.now();
      return;
    }
    if (Date.now() - lastProgressAt >= stallMs) {
      stop();
      onStall();
    }
  }, 1000);
  if (interval.unref) interval.unref();
  return { note, stop };
}

// Streaming render (concurrent): Dolphin keeps dumping while ffmpeg encodes the
// growing frame/audio dumps in real time (via `tail -F` FIFOs), emitting a
// fragmented mp4 on stdout so the VOD is watchable long before Dolphin finishes.
// Returns { stream, done, kill, cleanup }; the caller must call cleanup() once
// the stream has been fully consumed to remove the temp Dolphin userDir.
async function renderReplayToMp4Stream({ replayPath, config, onLog, signal }) {
  ensureConfigured(config);
  if (!fs.existsSync(replayPath)) {
    throw new Error(`Replay file not found: ${replayPath}`);
  }

  const timeoutMs = Number(config.renderTimeoutMs) || DEFAULT_RENDER_TIMEOUT_MS;
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "slippi-render-"));
  writeDolphinConfig(userDir);
  const commPath = writeCommFile(userDir, replayPath);

  // Calculated replay length (in rendered frames). Once the encode covers this,
  // the whole replay is on tape; we stop Dolphin rather than waiting for (or
  // failing on) the frame= counter to go idle while Dolphin winds down.
  const lastFrame = readReplayLastFrame(replayPath);
  const totalReplayFrames =
    lastFrame != null ? lastFrame + REPLAY_START_FRAME_OFFSET : null;

  const framesDir = path.join(userDir, "Dump", "Frames");
  const audioDir = path.join(userDir, "Dump", "Audio");
  // ffmpeg writes the fragmented mp4 here. Using a file (not a pipe) gives an
  // unbounded on-disk buffer, so a slow upload can never back-pressure ffmpeg and
  // trip the stall watchdog. The uploader follows this file as it grows.
  const outputPath = path.join(userDir, "output.mp4");

  const fifos = [];
  const tails = [];
  let dolphin = null;
  let ffmpeg = null;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // RENDER_KEEP_DUMPS preserves the Dolphin dump dir so a failed render can be
    // inspected (e.g. the partial framedump0.avi) instead of being deleted.
    if (process.env.RENDER_KEEP_DUMPS) {
      onLog?.(`Keeping dump dir for debugging: ${userDir}`);
      return;
    }
    fs.rm(userDir, { recursive: true, force: true }, () => {});
  };
  const stopTails = () => {
    for (const tail of tails) {
      try {
        tail.kill("SIGTERM");
      } catch {}
    }
  };
  const killAll = () => {
    try {
      dolphin?.kill?.();
    } catch {}
    stopTails();
    try {
      ffmpeg?.kill?.();
    } catch {}
  };

  try {
    onLog?.(`Launching Dolphin to render ${path.basename(replayPath)}`);
    dolphin = spawnDolphinDump({ userDir, commPath, config, onLog, signal, timeoutMs });
    // Handled by the orchestrator below; guard against unhandled rejection while
    // we await the dump file appearing.
    dolphin.done.catch(() => {});

    const videoDump = await waitForDumpFile(framesDir, VIDEO_EXTENSIONS, {
      signal,
      timeoutMs,
      minSize: DUMP_HEADER_BYTES,
      dolphinExited: dolphin.isSettled,
    });
    if (!videoDump) {
      const tail = dolphin.getOutput().slice(-15).join("\n").trim();
      throw new Error(
        `Dolphin did not produce a frame dump.${tail ? `\nDolphin output:\n${tail}` : ""}`
      );
    }
    const audioDump = await waitForDumpFile(audioDir, AUDIO_EXTENSIONS, {
      signal,
      timeoutMs,
      minSize: 1,
      dolphinExited: dolphin.isSettled,
    });

    const videoFifo = path.join(userDir, "video.pipe");
    fifos.push(videoFifo);
    let audioFifo = null;
    if (audioDump) {
      audioFifo = path.join(userDir, "audio.pipe");
      fifos.push(audioFifo);
    }
    execFileSync("mkfifo", fifos);

    tails.push(spawnTail(videoDump, videoFifo, onLog));
    if (audioFifo) tails.push(spawnTail(audioDump, audioFifo, onLog));

    // Fragmented mp4 (empty_moov + frag_keyframe) is progressively playable while
    // still being written, which faststart cannot do for a growing file.
    const ffmpegArgs = buildFfmpegArgs(
      videoFifo,
      audioFifo,
      ["-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", outputPath],
      { maxVideoFrames: totalReplayFrames }
    );
    // Opt-in only (separate from RENDER_KEEP_DUMPS): -loglevel verbose -debug_ts
    // is a per-packet firehose that can back up ffmpeg's stderr pipe faster than
    // the daemon drains it, blocking the encode mid-render and tripping the stall
    // watchdog. Keep it off by default so normal (dump-preserving) runs stay live.
    if (process.env.RENDER_FFMPEG_DEBUG) {
      ffmpegArgs.unshift("-loglevel", "verbose", "-debug_ts");
    }

    onLog?.(`Streaming mp4 with ffmpeg for ${path.basename(replayPath)}`);
    if (totalReplayFrames != null) {
      onLog?.(`Calculated replay length: ${totalReplayFrames} frames`);
    }

    let stallError = null;
    let tailsDrained = false;
    let dolphinExited = false;
    // Latest frame ffmpeg has reported plus when it last advanced, so the drain
    // fallback can tell when the encode has emptied the (now-final) dump.
    let lastEncodedFrame = -1;
    let lastEncodedAt = Date.now();

    // Close the tails so ffmpeg reads EOF and finalizes. With -frames:v ffmpeg
    // normally stops itself at the exact replay length, so this is only a
    // fallback: the replay length was unknown, or Dolphin's dump ended a hair
    // short of the target and ffmpeg is now waiting on frames that will never
    // arrive. Wait for its frame= counter to plateau against the finalized dump
    // before cutting the pipes so we never truncate mid-drain.
    const drainAndStopTails = async () => {
      if (tailsDrained) return;
      tailsDrained = true;
      lastEncodedAt = Date.now();
      const drainDeadline = Date.now() + TAIL_DRAIN_MAX_MS;
      while (Date.now() < drainDeadline) {
        if (Date.now() - lastEncodedAt >= TAIL_DRAIN_PLATEAU_MS) break;
        await delay(250, signal).catch(() => {});
      }
      stopTails();
    };

    const onFrameProgress = (frame) => {
      if (frame > lastEncodedFrame) {
        lastEncodedFrame = frame;
        lastEncodedAt = Date.now();
      }
      stallWatch.note(frame);
    };

    // Once Dolphin has exited its dump is final, so a frozen encode just means
    // we're at the end — close the pipes to finalize. While Dolphin is still
    // running a freeze is a genuinely stuck render, so fail it.
    const stallWatch = watchEncodeStall({
      stallMs: Number(config.encodeStallMs) || ENCODE_STALL_MS,
      signal,
      inputFile: videoDump,
      onStall: () => {
        if (dolphinExited) {
          onLog?.("Encode idle on finalized dump; closing pipes to finalize render");
          drainAndStopTails();
          return;
        }
        onLog?.("ffmpeg encode stopped advancing while Dolphin still running; failing render");
        stallError = new Error("Frame dump stalled; Dolphin appears stuck");
        killAll();
      },
    });

    ffmpeg = spawnFfmpegStream(config.ffmpegPath || "ffmpeg", ffmpegArgs, {
      timeoutMs,
      signal,
      onLog,
      onProgress: onFrameProgress,
    });

    // Dolphin exits on its own once the game (and its idle wind-down) is done;
    // its dump is then final. With a known replay length ffmpeg stops itself at
    // its -frames:v target, so we just note the exit (the stall watch closes the
    // pipes if the dump came up short). Without a target, drain and close now.
    dolphin.done.then(
      () => {
        dolphinExited = true;
        if (totalReplayFrames == null) drainAndStopTails();
      },
      () => {
        dolphinExited = true;
        drainAndStopTails();
      }
    );
    ffmpeg.done.catch(() => killAll());

    const done = (async () => {
      try {
        await ffmpeg.done;
        if (stallError) throw stallError;
      } finally {
        stallWatch.stop();
        killAll();
      }
    })();

    return { outputPath, done, kill: killAll, cleanup };
  } catch (error) {
    killAll();
    cleanup();
    throw error;
  }
}

function makeTempOutputPath(replayName) {
  const stem = path.basename(replayName, path.extname(replayName)) || "render";
  const unique = crypto.randomBytes(6).toString("hex");
  return path.join(os.tmpdir(), `slippi-render-${stem}-${unique}.mp4`);
}

// A Readable that streams `filePath` and keeps following it as it grows, so the
// upload can progress while ffmpeg is still writing. It waits for the file to
// appear, emits bytes as they land, and only ends once `isFinished()` reports
// the encode has exited AND we've read up to the file's current size.
function createFollowingReadStream(filePath, isFinished, { pollMs = 100 } = {}) {
  let position = 0;
  let fd = null;
  const chunkSize = 1024 * 1024;
  const buf = Buffer.allocUnsafe(chunkSize);

  return new Readable({
    read() {
      const attempt = () => {
        try {
          if (fd === null) {
            if (!fs.existsSync(filePath)) {
              if (isFinished()) return void this.push(null);
              return void setTimeout(attempt, pollMs);
            }
            fd = fs.openSync(filePath, "r");
          }
          const size = fs.fstatSync(fd).size;
          if (size > position) {
            const len = Math.min(size - position, chunkSize);
            const bytes = fs.readSync(fd, buf, 0, len, position);
            position += bytes;
            return void this.push(Buffer.from(buf.subarray(0, bytes)));
          }
          if (isFinished()) return void this.push(null);
          setTimeout(attempt, pollMs);
        } catch (error) {
          this.destroy(error);
        }
      };
      attempt();
    },
    destroy(error, callback) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
        fd = null;
      }
      callback(error);
    },
  });
}

module.exports = {
  renderReplayToMp4,
  renderReplayToMp4Stream,
  makeTempOutputPath,
  createFollowingReadStream,
};
