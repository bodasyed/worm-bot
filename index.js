const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const express = require("express");
let FONT_FAMILY = "sans-serif";
try {
  GlobalFonts.registerFromPath(path.join(__dirname, "font.ttf"), "RankFont");
  FONT_FAMILY = "RankFont";
} catch (e) {
  console.warn("Font not loaded:", e.message);
}
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const TEMP_DATA_FILE = `${DATA_FILE}.tmp`;
const XP_COOLDOWN_MS = 60_000;
const SESSION_COOKIE_NAME = "discord_dashboard_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_CONFIGURABLE_XP = 1;
const MAX_CONFIGURABLE_XP = 10_000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const commands = [
  new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Show a user's level and XP rank.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The user whose rank you want to see.")
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the server's top 10 users by XP."),
].map((command) => command.toJSON());

let database = {};
let saveQueue = Promise.resolve();
const cooldowns = new Map();
const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "12kb" }));
app.use((request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'self' https://replit.com https://*.replit.com https://*.replit.dev https://*.replit.app",
  );
  next();
});

function defaultGuildSettings() {
  return {
    announcementChannelId: "",
    levelingEnabled: true,
    xpMin: 15,
    xpMax: 25,
  };
}

function normalizeGuildSettings(settings) {
  const defaults = defaultGuildSettings();
  const xpMin =
    Number.isInteger(settings?.xpMin) &&
    settings.xpMin >= MIN_CONFIGURABLE_XP &&
    settings.xpMin <= MAX_CONFIGURABLE_XP
      ? settings.xpMin
      : defaults.xpMin;
  const storedMax =
    Number.isInteger(settings?.xpMax) &&
    settings.xpMax >= MIN_CONFIGURABLE_XP &&
    settings.xpMax <= MAX_CONFIGURABLE_XP
      ? settings.xpMax
      : defaults.xpMax;

  return {
    announcementChannelId:
      typeof settings?.announcementChannelId === "string"
        ? settings.announcementChannelId
        : defaults.announcementChannelId,
    levelingEnabled:
      typeof settings?.levelingEnabled === "boolean"
        ? settings.levelingEnabled
        : defaults.levelingEnabled,
    xpMin,
    xpMax: Math.max(xpMin, storedMax),
  };
}

function getGuildSettings(guildId) {
  database.settings ||= {};
  return database.settings[guildId] || defaultGuildSettings();
}

function logError(context, error) {
  if (error instanceof Error) {
    console.error(`[${context}] ${error.message}`);
    if (error.stack) console.error(error.stack);
    return;
  }

  console.error(`[${context}]`, error);
}

function xpNeededForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function getLevelProgress(totalXp) {
  let remainingXp = Math.max(0, totalXp);
  let level = 0;
  let neededXp = xpNeededForLevel(level);

  while (remainingXp >= neededXp) {
    remainingXp -= neededXp;
    level += 1;
    neededXp = xpNeededForLevel(level);
  }

  return { level, currentXp: remainingXp, neededXp };
}

function normalizeProfile(profile) {
  const xp = Number.isFinite(profile?.xp) ? Math.max(0, Math.floor(profile.xp)) : 0;
  const messages = Number.isFinite(profile?.messages)
    ? Math.max(0, Math.floor(profile.messages))
    : 0;
  const { level } = getLevelProgress(xp);

  return { xp, level, messages };
}

async function loadDatabase() {
  try {
    const contents = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(contents);

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("data.json must contain an object keyed by guild and user IDs.");
    }

    database = Object.fromEntries(
      Object.entries(parsed)
        .filter(([key]) => key !== "settings")
        .map(([key, profile]) => [key, normalizeProfile(profile)]),
    );
    database.settings = {};

    if (parsed.settings && typeof parsed.settings === "object" && !Array.isArray(parsed.settings)) {
      for (const [guildId, settings] of Object.entries(parsed.settings)) {
        database.settings[guildId] = normalizeGuildSettings(settings);
      }
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      database = { settings: {} };
      return;
    }

    throw new Error(`Could not load ${DATA_FILE}. Fix or remove the invalid data file before restarting.`, {
      cause: error,
    });
  }
}

function saveDatabase() {
  const snapshot = JSON.stringify(database, null, 2);
  const writeOperation = saveQueue.then(async () => {
    await fs.writeFile(TEMP_DATA_FILE, snapshot, "utf8");
    await fs.rename(TEMP_DATA_FILE, DATA_FILE);
  });

  saveQueue = writeOperation.catch((error) => {
    logError("Could not save data.json", error);
  });

  return writeOperation;
}

function profileKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getGuildProfiles(guildId) {
  const prefix = `${guildId}:`;

  return Object.entries(database)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, profile]) => ({
      userId: key.slice(prefix.length),
      ...profile,
    }))
    .sort((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const replacements = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return replacements[character];
  });
}

function getTextChannels(guild) {
  if (!guild) return [];

  return [...guild.channels.cache.values()]
    .filter(
      (channel) =>
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement,
    )
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

function getRequestCookie(request, name) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;

    if (pair.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(pair.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }

  return null;
}

function createDashboardSessionToken() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${expiresAt}.${nonce}`;
  const signature = crypto
    .createHmac("sha256", DASHBOARD_PASSWORD)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function isDashboardSessionValid(token) {
  if (typeof token !== "string") return false;

  const [expiresAtText, nonce, signature, ...extraParts] = token.split(".");
  if (extraParts.length > 0 || !/^\d+$/.test(expiresAtText || "")) return false;
  if (!/^[a-f0-9]{32}$/.test(nonce || "")) return false;

  const expiresAt = Number(expiresAtText);
  if (!Number.isSafeInteger(expiresAt)) return false;
  if (expiresAt <= Date.now() || expiresAt - Date.now() > SESSION_TTL_MS) return false;

  const payload = `${expiresAtText}.${nonce}`;
  const expectedSignature = crypto
    .createHmac("sha256", DASHBOARD_PASSWORD)
    .update(payload)
    .digest();
  const providedSignature = Buffer.from(signature || "", "base64url");

  return (
    providedSignature.length === expectedSignature.length &&
    crypto.timingSafeEqual(providedSignature, expectedSignature)
  );
}

function isDashboardAuthenticated(request) {
  return isDashboardSessionValid(getRequestCookie(request, SESSION_COOKIE_NAME));
}

function setDashboardSessionCookie(request, response) {
  const secure = request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(createDashboardSessionToken())}; Path=/; HttpOnly; SameSite=Lax${secure}`,
  );
}

function clearDashboardSessionCookie(request, response) {
  const secure = request.secure ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

function passwordMatches(candidate) {
  if (typeof candidate !== "string") return false;

  const expected = crypto.createHash("sha256").update(DASHBOARD_PASSWORD).digest();
  const received = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expected, received);
}

function renderLoginPage(errorMessage = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bot settings · Sign in</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1020; color: #edf1ff; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(ellipse at 50% 0%, #202d53 0%, #10172b 46%, #0b1020 100%); }
    main { width: min(100%, 420px); padding: 34px; border: 1px solid #2c3857; border-radius: 20px; background: rgba(16, 24, 43, .94); box-shadow: 0 24px 80px rgba(0, 0, 0, .38); }
    .eyebrow { margin: 0 0 10px; color: #9aa9ce; font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: 28px; letter-spacing: -.04em; }
    .intro { margin: 12px 0 26px; color: #a8b3cb; line-height: 1.55; }
    label { display: block; margin-bottom: 8px; color: #dce3f4; font-size: 14px; font-weight: 600; }
    input { width: 100%; padding: 13px 14px; border: 1px solid #34415f; border-radius: 10px; outline: none; background: #0c1324; color: #f7f8ff; font: inherit; }
    input:focus { border-color: #8b9aff; box-shadow: 0 0 0 3px rgba(124, 140, 255, .2); }
    button { width: 100%; margin-top: 18px; padding: 13px 16px; border: 0; border-radius: 10px; background: #7c8cff; color: #10152a; cursor: pointer; font: inherit; font-weight: 750; }
    button:hover { background: #98a4ff; }
    .error { margin: 16px 0 0; padding: 11px 12px; border: 1px solid #803e55; border-radius: 9px; background: #351c2a; color: #ffc6d5; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Discord bot</p>
    <h1>Settings dashboard</h1>
    <p class="intro">Sign in to manage leveling and XP settings for this server.</p>
    <form action="/login" method="post">
      <label for="password">Dashboard password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Sign in</button>
    </form>
    ${errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
  </main>
</body>
</html>`;
}

function renderSettingsPage(guild, settings, errorMessage = "") {
  const channels = getTextChannels(guild);
  let channelOptions = "";

  if (!guild) {
    channelOptions = '<option value="" selected>Invite the bot to load channels</option>';
  } else {
    const selectedChannelExists = channels.some(
      (channel) => channel.id === settings.announcementChannelId,
    );
    channelOptions = `<option value=""${settings.announcementChannelId ? "" : " selected"}>No announcement channel</option>`;

    if (settings.announcementChannelId && !selectedChannelExists) {
      channelOptions += '<option value="" selected>Saved channel unavailable</option>';
    }

    channelOptions += channels
      .map(
        (channel) =>
          `<option value="${escapeHtml(channel.id)}"${channel.id === settings.announcementChannelId ? " selected" : ""}># ${escapeHtml(channel.name)}</option>`,
      )
      .join("");
  }

  const guildLabel = guild
    ? escapeHtml(guild.name)
    : "Waiting for the bot to join the configured server";
  const disabledChannelSelect = guild ? "" : " disabled";
  const levelingChecked = settings.levelingEnabled ? " checked" : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bot settings</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b1020; color: #edf1ff; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; padding: 40px 22px 64px; background: radial-gradient(ellipse at 85% -5%, #1c2b50 0%, #111a31 34%, #0b1020 72%); }
    main { width: min(100%, 840px); margin: 0 auto; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 26px; }
    .eyebrow { margin: 0 0 9px; color: #9aa9ce; font-size: 12px; font-weight: 750; letter-spacing: .16em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(29px, 5vw, 42px); letter-spacing: -.05em; line-height: 1.1; }
    .server { margin: 12px 0 0; color: #9aa9ce; font-size: 14px; }
    .panel { overflow: hidden; border: 1px solid #2c3857; border-radius: 18px; background: rgba(16, 24, 43, .92); box-shadow: 0 24px 80px rgba(0, 0, 0, .25); }
    .panel-head { padding: 24px 28px 20px; border-bottom: 1px solid #26324d; }
    .panel-head h2 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
    .panel-head p { margin: 7px 0 0; color: #95a2bf; font-size: 14px; line-height: 1.5; }
    form.settings { padding: 26px 28px 28px; }
    .field { margin-bottom: 24px; }
    .field label, .field-title { display: block; margin-bottom: 8px; color: #dce3f4; font-size: 14px; font-weight: 650; }
    .hint { margin: 7px 0 0; color: #8794b2; font-size: 13px; line-height: 1.5; }
    select, input[type=number] { width: 100%; min-height: 46px; padding: 11px 13px; border: 1px solid #34415f; border-radius: 10px; outline: none; background: #0c1324; color: #f7f8ff; font: inherit; }
    select:focus, input[type=number]:focus { border-color: #8b9aff; box-shadow: 0 0 0 3px rgba(124, 140, 255, .2); }
    select:disabled { opacity: .58; cursor: not-allowed; }
    .check-row { display: flex; align-items: flex-start; gap: 13px; }
    input[type=checkbox] { width: 19px; height: 19px; margin: 1px 0 0; accent-color: #8493ff; }
    .check-copy { display: grid; gap: 5px; }
    .check-copy label { margin: 0; }
    .check-copy .hint { margin: 0; }
    .number-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding-top: 8px; }
    button { min-height: 44px; padding: 11px 20px; border: 0; border-radius: 10px; background: #8794ff; color: #10152a; cursor: pointer; font: inherit; font-weight: 750; }
    button:hover { background: #a0aaff; }
    .logout { padding: 0; border: 0; background: none; color: #a8b3cb; cursor: pointer; font: inherit; }
    .logout:hover { background: none; color: #edf1ff; }
    .error { margin: 0 0 22px; padding: 12px 14px; border: 1px solid #803e55; border-radius: 10px; background: #351c2a; color: #ffc6d5; font-size: 14px; }
    @media (max-width: 560px) { body { padding: 26px 14px 42px; } header { display: block; } .panel-head, form.settings { padding-left: 19px; padding-right: 19px; } .number-grid { grid-template-columns: 1fr; gap: 0; } .actions { align-items: flex-start; flex-direction: column-reverse; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Discord bot</p>
        <h1>Leveling settings</h1>
        <p class="server">${guildLabel}</p>
      </div>
      <form action="/logout" method="post">
        <button class="logout" type="submit">Sign out</button>
      </form>
    </header>
    <section class="panel">
      <div class="panel-head">
        <h2>Leveling</h2>
        <p>Choose where level-ups are announced and how quickly members earn XP.</p>
      </div>
      <form class="settings" action="/settings" method="post">
        ${errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
        <div class="field">
          <label for="announcementChannelId">Level-up announcement channel</label>
          <select id="announcementChannelId" name="announcementChannelId"${disabledChannelSelect}>
            ${channelOptions}
          </select>
          <p class="hint">Leave this set to “No announcement channel” to disable level-up messages.</p>
        </div>
        <div class="field">
          <div class="check-row">
            <input id="levelingEnabled" name="levelingEnabled" type="checkbox" value="true"${levelingChecked}>
            <div class="check-copy">
              <label for="levelingEnabled">Enable leveling</label>
              <p class="hint">When disabled, messages won't earn XP or count toward leveling.</p>
            </div>
          </div>
        </div>
        <div class="field">
          <span class="field-title">XP per message</span>
          <div class="number-grid">
            <div>
              <label for="xpMin">Minimum XP</label>
              <input id="xpMin" name="xpMin" type="number" min="${MIN_CONFIGURABLE_XP}" max="${MAX_CONFIGURABLE_XP}" step="1" value="${settings.xpMin}" required>
            </div>
            <div>
              <label for="xpMax">Maximum XP</label>
              <input id="xpMax" name="xpMax" type="number" min="${MIN_CONFIGURABLE_XP}" max="${MAX_CONFIGURABLE_XP}" step="1" value="${settings.xpMax}" required>
            </div>
          </div>
          <p class="hint">A random amount in this range is awarded once per member every 60 seconds.</p>
        </div>
        <div class="actions">
          <span class="hint">Settings are saved to this bot's data.json file.</span>
          <button type="submit">Save</button>
        </div>
      </form>
    </section>
  </main>
</body>
</html>`;
}

app.get("/", (request, response) => {
  if (!isDashboardAuthenticated(request)) {
    return response.type("html").send(renderLoginPage());
  }

  const guild = client.guilds.cache.get(GUILD_ID) || null;
  return response.type("html").send(
    renderSettingsPage(guild, getGuildSettings(GUILD_ID)),
  );
});

app.post("/login", (request, response) => {
  if (!passwordMatches(request.body?.password)) {
    return response
      .status(401)
      .type("html")
      .send(renderLoginPage("That password didn't match. Please try again."));
  }

  setDashboardSessionCookie(request, response);
  return response.redirect(303, "/");
});

app.post("/logout", (request, response) => {
  clearDashboardSessionCookie(request, response);
  return response.redirect(303, "/");
});

app.post("/settings", async (request, response, next) => {
  try {
    if (!isDashboardAuthenticated(request)) {
      return response.redirect(303, "/");
    }

    const guild = client.guilds.cache.get(GUILD_ID) || null;
    const currentSettings = getGuildSettings(GUILD_ID);
    const xpMin = Number(request.body?.xpMin);
    const xpMax = Number(request.body?.xpMax);
    let announcementChannelId =
      typeof request.body?.announcementChannelId === "string"
        ? request.body.announcementChannelId
        : "";

    if (!guild) {
      announcementChannelId = currentSettings.announcementChannelId;
    }

    if (
      !Number.isInteger(xpMin) ||
      !Number.isInteger(xpMax) ||
      xpMin < MIN_CONFIGURABLE_XP ||
      xpMax > MAX_CONFIGURABLE_XP ||
      xpMin > xpMax
    ) {
      return response
        .status(400)
        .type("html")
        .send(
          renderSettingsPage(
            guild,
            currentSettings,
            `XP values must be whole numbers from ${MIN_CONFIGURABLE_XP} to ${MAX_CONFIGURABLE_XP}, and the maximum must be at least the minimum.`,
          ),
        );
    }

    if (
      guild &&
      announcementChannelId &&
      !getTextChannels(guild).some((channel) => channel.id === announcementChannelId)
    ) {
      return response
        .status(400)
        .type("html")
        .send(
          renderSettingsPage(guild, currentSettings, "Choose a text channel from this server."),
        );
    }

    const previousSettings = database.settings[GUILD_ID];
    database.settings[GUILD_ID] = normalizeGuildSettings({
      announcementChannelId,
      levelingEnabled: request.body?.levelingEnabled === "true",
      xpMin,
      xpMax,
    });

    try {
      await saveDatabase();
    } catch (error) {
      database.settings[GUILD_ID] = previousSettings || defaultGuildSettings();
      throw error;
    }

    return response.redirect(303, "/");
  } catch (error) {
    next(error);
  }
});

app.use((request, response) => {
  response.status(404).type("text/plain").send("Not found");
});

app.use((error, request, response, next) => {
  logError("Dashboard request failed", error);
  if (response.headersSent) return next(error);
  return response.status(500).type("text/plain").send("The dashboard could not complete that request.");
});

let dashboardServer = null;

function startDashboardServer() {
  return new Promise((resolve, reject) => {
    let listening = false;
    const server = app.listen(PORT, "0.0.0.0");

    server.on("error", (error) => {
      if (!listening) {
        reject(error);
      } else {
        logError("Dashboard server error", error);
      }
    });

    server.once("listening", () => {
      listening = true;
      console.log(`Settings dashboard listening on port ${PORT}.`);
      resolve(server);
    });
  });
}

async function registerCommands(readyClient) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  await rest.put(Routes.applicationGuildCommands(readyClient.user.id, GUILD_ID), {
    body: commands,
  });

  console.log("Registered slash commands for the configured server.");
}

function drawRoundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function fitFontSize(context, text, maxWidth, startingSize) {
  let size = startingSize;

  while (size > 24) {
        context.font = `700 ${size}px ${FONT_FAMILY}`;
    if (context.measureText(text).width <= maxWidth) break;
 async function renderRankCard(user, profile, rank) {
  const W = 1000, H = 340;
  const canvas = createCanvas(W, H);
  const context = canvas.getContext("2d");

  const progress = getLevelProgress(profile.xp);
  const progressRatio = Math.max(0, Math.min(1, progress.currentXp / progress.neededXp));

  // background
  const bg = context.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#0f1220");
  bg.addColorStop(0.5, "#141a2e");
  bg.addColorStop(1, "#0d1424");
  context.fillStyle = bg;
  context.fillRect(0, 0, W, H);

  // glow accents
  context.save();
  context.globalAlpha = 0.14;
  context.fillStyle = "#7c8cff";
  context.beginPath(); context.arc(900, 30, 210, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#a78bfa";
  context.beginPath(); context.arc(780, 340, 170, 0, Math.PI * 2); context.fill();
  context.restore();

  // card
  drawRoundedRect(context, 18, 18, W - 36, H - 36, 28);
  context.fillStyle = "rgba(15, 20, 38, 0.72)";
  context.fill();
  context.strokeStyle = "rgba(124, 140, 255, 0.28)";
  context.lineWidth = 2;
  context.stroke();

  // avatar + ring
  const centerX = 165, centerY = H / 2, ringRadius = 96, ringWidth = 12;

  context.beginPath();
  context.arc(centerX, centerY, ringRadius, 0, Math.PI * 2);
  context.strokeStyle = "rgba(255,255,255,0.10)";
  context.lineWidth = ringWidth;
  context.stroke();

  if (progressRatio > 0) {
    context.beginPath();
    context.arc(centerX, centerY, ringRadius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progressRatio);
    const ringGrad = context.createLinearGradient(centerX - ringRadius, 0, centerX + ringRadius, 0);
    ringGrad.addColorStop(0, "#5865f2");
    ringGrad.addColorStop(1, "#a78bfa");
    context.strokeStyle = ringGrad;
    context.lineWidth = ringWidth;
    context.lineCap = "round";
    context.stroke();
  }

  try {
    const avatarUrl = user.displayAvatarURL({ extension: "png", forceStatic: true, size: 256 });
    const avatar = await loadImage(avatarUrl);
    const inner = ringRadius - ringWidth / 2 - 6;
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, inner, 0, Math.PI * 2);
    context.closePath();
    context.clip();
    context.drawImage(avatar, centerX - inner, centerY - inner, inner * 2, inner * 2);
    context.restore();
  } catch (e) {}

  // text
  const x = 300;
  const username = user.globalName || user.username;
  const nameSize = fitFontSize(context, username, 600, 46);
  context.font = `700 ${nameSize}px ${FONT_FAMILY}`;
  context.fillStyle = "#ffffff";
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(username, x, 108);

  context.font = `600 22px ${FONT_FAMILY}`;
  context.fillStyle = "#8f9bb5";
  context.fillText("RANK", x, 158);
  context.font = `700 30px ${FONT_FAMILY}`;
  context.fillStyle = "#a78bfa";
  context.fillText(`#${rank}`, x + 92, 158);

  // level pill
  const pillW = 150, pillH = 44, pillX = x + 210, pillY = 130;
  drawRoundedRect(context, pillX, pillY, pillW, pillH, pillH / 2);
  const pillGrad = context.createLinearGradient(pillX, 0, pillX + pillW, 0);
  pillGrad.addColorStop(0, "rgba(88,101,242,0.35)");
  pillGrad.addColorStop(1, "rgba(167,139,250,0.35)");
  context.fillStyle = pillGrad;
  context.fill();
  context.font = `700 22px ${FONT_FAMILY}`;
  context.fillStyle = "#dfe4ff";
  context.textAlign = "center";
  context.fillText(`LEVEL ${progress.level}`, pillX + pillW / 2, pillY + 29);
  context.textAlign = "left";

  // progress bar
  const barX = x, barY = 200, barW = 620, barH = 26;
  drawRoundedRect(context, barX, barY, barW, barH, barH / 2);
  context.fillStyle = "rgba(255,255,255,0.08)";
  context.fill();

  const fillW = Math.max(barH, barW * progressRatio);
  drawRoundedRect(context, barX, barY, fillW, barH, barH / 2);
  const barGrad = context.createLinearGradient(barX, 0, barX + barW, 0);
  barGrad.addColorStop(0, "#5865f2");
  barGrad.addColorStop(1, "#a78bfa");
  context.fillStyle = barGrad;
  context.fill();

  // xp text
  context.font = `600 20px ${FONT_FAMILY}`;
  context.fillStyle = "#cbd2ff";
  context.textAlign = "right";
  context.fillText(`${progress.currentXp} / ${progress.neededXp} XP`, barX + barW, barY - 12);
  context.textAlign = "left";

  // messages
  context.font = `500 18px ${FONT_FAMILY}`;
  context.fillStyle = "#8f9bb5";
  context.fillText(`${profile.messages || 0} messages`, x, 272);

  return canvas.encode("png");
} 
  context.font = "500 15px Arial";
  context.fillStyle = "#8f9bb5";
  context.fillText(`${profile.messages} messages`, 310, 294);

  return canvas.encode("png");
}

async function handleRank(interaction) {
  await interaction.deferReply();

  const user = interaction.options.getUser("user") || interaction.user;
  const key = profileKey(interaction.guildId, user.id);
  const profile = database[key] || { xp: 0, level: 0, messages: 0 };
  const profiles = getGuildProfiles(interaction.guildId);
  const targetIndex = profiles.findIndex((entry) => entry.userId === user.id);

  if (targetIndex === -1) {
    profiles.push({ userId: user.id, xp: profile.xp, level: profile.level, messages: 0 });
    profiles.sort((a, b) => b.xp - a.xp || a.userId.localeCompare(b.userId));
  }

  const rank = profiles.findIndex((entry) => entry.userId === user.id) + 1;
  const image = await renderRankCard(user, profile, rank);
  const attachment = new AttachmentBuilder(image, { name: "rank.png" });

  await interaction.editReply({ files: [attachment] });
}

async function handleLeaderboard(interaction) {
  await interaction.deferReply();

  const topUsers = getGuildProfiles(interaction.guildId).slice(0, 10);
  const description =
    topUsers.length === 0
      ? "No users have earned XP yet."
      : topUsers
          .map(
            (profile, index) =>
              `**${index + 1}.** <@${profile.userId}> — Level ${profile.level} · ${profile.xp} XP`,
          )
          .join("\n");

  const embed = new EmbedBuilder()
    .setColor(0x7c8cff)
    .setTitle("Server Leaderboard")
    .setDescription(description)
    .setFooter({ text: "Ranked by total XP" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild() || interaction.guildId !== GUILD_ID) return;

  if (interaction.commandName === "rank") {
    await handleRank(interaction);
    return;
  }

  if (interaction.commandName === "leaderboard") {
    await handleLeaderboard(interaction);
  }
}

async function replyWithCommandError(interaction) {
  const payload = {
    content: "Something went wrong while running that command. Please try again.",
    embeds: [],
    files: [],
  };

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
    } else {
      await interaction.reply({ ...payload, ephemeral: true });
    }
  } catch (error) {
    logError("Could not send command error response", error);
  }
}

async function handleGuildMessage(message) {
  const settings = getGuildSettings(message.guild.id);
  if (!settings.levelingEnabled) return;

  const key = profileKey(message.guild.id, message.author.id);
  const profile = (database[key] ||= { xp: 0, level: 0, messages: 0 });
  const now = Date.now();
  const lastEarnedAt = cooldowns.get(key) || 0;
  const previousLevel = profile.level;

  profile.messages += 1;

  if (now - lastEarnedAt >= XP_COOLDOWN_MS) {
    const xpEarned =
      Math.floor(Math.random() * (settings.xpMax - settings.xpMin + 1)) + settings.xpMin;
    profile.xp += xpEarned;
    profile.level = getLevelProgress(profile.xp).level;
    cooldowns.set(key, now);
  }

  await saveDatabase();

  if (profile.level <= previousLevel || !settings.announcementChannelId) return;

  const channel = message.guild.channels.cache.get(settings.announcementChannelId);
  if (!channel || typeof channel.send !== "function" || !channel.isTextBased()) {
    console.warn("The configured level-up channel is unavailable. Update it in the settings dashboard.");
    return;
  }

  for (let level = previousLevel + 1; level <= profile.level; level += 1) {
    await channel.send({
      content: `🎉 <@${message.author.id}> reached level ${level}!`,
      allowedMentions: { users: [message.author.id] },
    });
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Connected as ${readyClient.user.tag}.`);

  if (!readyClient.guilds.cache.has(GUILD_ID)) {
    console.warn(
      "Waiting to join the configured server. Invite this bot with the `bot` and `applications.commands` scopes.",
    );
    return;
  }

  void registerCommands(readyClient).catch((error) =>
    logError("Slash command registration failed", error),
  );
});

client.on(Events.GuildCreate, (guild) => {
  if (guild.id !== process.env.GUILD_ID) {
    void guild.leave().catch((error) => logError(`Could not leave guild ${guild.id}`, error));
    return;
  }

  if (client.isReady()) {
    void registerCommands(client).catch((error) =>
      logError("Slash command registration failed", error),
    );
  }
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guild || message.author.bot || message.guild.id !== GUILD_ID) return;

  void handleGuildMessage(message).catch((error) =>
    logError(`Could not process message from user ${message.author.id}`, error),
  );
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(interaction).catch(async (error) => {
    logError(`Command ${interaction.commandName || "unknown"} failed`, error);
    await replyWithCommandError(interaction);
  });
});

client.on(Events.Error, (error) => logError("Discord client error", error));
client.on("shardError", (error) => logError("Discord gateway error", error));
client.on("warn", (warning) => console.warn(`[Discord warning] ${warning}`));
process.on("unhandledRejection", (error) => logError("Unhandled promise rejection", error));

async function main() {
  if (!DISCORD_TOKEN) throw new Error("Set DISCORD_TOKEN in the environment before starting the bot.");
  if (!DASHBOARD_PASSWORD) {
    throw new Error("Set DASHBOARD_PASSWORD in the environment before starting the bot.");
  }
  if (!/^\d{17,20}$/.test(GUILD_ID || "")) {
    throw new Error(
      "GUILD_ID must be a valid numeric Discord server ID. Enable Developer Mode, right-click the server, and choose Copy Server ID.",
    );
  }

  await loadDatabase();
  database.settings ||= {};
  database.settings[GUILD_ID] ||= defaultGuildSettings();
  await saveDatabase();

  dashboardServer = await startDashboardServer();
  await client.login(DISCORD_TOKEN);
}

main().catch((error) => {
  logError("Bot startup failed", error);
  if (dashboardServer?.listening) {
    dashboardServer.close((closeError) => {
      if (closeError) logError("Could not close dashboard server", closeError);
    });
  }
  client.destroy();
  process.exitCode = 1;
});
