// Load values from a local .env file into process.env so the bot can read its token and settings.
require("dotenv").config();

// Import the Discord.js classes we need for login, permissions, and voice-channel handling.
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");

// Create the bot client and subscribe to the gateway events we need.
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Read configuration from environment variables and convert some values into usable types.
const config = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  monitoredChannelIds: (process.env.MONITORED_CHANNEL_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),
  idleChannelId: process.env.IDLE_CHANNEL_ID,
  gracePeriodMs: Number(process.env.GRACE_PERIOD_SECONDS || 120) * 1000,
  checkIntervalMs: Number(process.env.CHECK_INTERVAL_SECONDS || 10) * 1000,
  delayWarning: Number(process.env.WARNING_TIME || 30) * 1000,
  dmWarnings:
    String(process.env.DM_WARNINGS || "true").toLowerCase() === "true",
  logLevel: process.env.LOG_LEVEL || "info",
};

// Store one active timeout per member so the bot does not create duplicate timers.
const pendingChecks = new Map();

// Helper to print consistent timestamped log lines.
function log(level, message, extra = null) {
  const levels = ["debug", "info", "warn", "error"];
  if (levels.indexOf(level) < levels.indexOf(config.logLevel)) return;

  const stamp = new Date().toISOString();
  if (extra) {
    console.log(`[${stamp}] [${level.toUpperCase()}] ${message}`, extra);
  } else {
    console.log(`[${stamp}] [${level.toUpperCase()}] ${message}`);
  }
}

// Stop early if the required environment variables are missing or invalid.
function validateConfig() {
  const missing = [];
  if (!config.token) missing.push("DISCORD_TOKEN");
  if (!config.guildId) missing.push("GUILD_ID");
  if (!config.idleChannelId) missing.push("IDLE_CHANNEL_ID");
  if (config.monitoredChannelIds.length === 0)
    missing.push("MONITORED_CHANNEL_IDS");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
  if (!Number.isFinite(config.gracePeriodMs) || config.gracePeriodMs < 5000) {
    throw new Error(
      "GRACE_PERIOD_SECONDS must be a number of at least 5 seconds.",
    );
  }
  if (
    !Number.isFinite(config.checkIntervalMs) ||
    config.checkIntervalMs < 5000
  ) {
    throw new Error(
      "CHECK_INTERVAL_SECONDS must be a number of at least 5 seconds.",
    );
  }
}

// Return true when a voice channel is one of the study channels we want to enforce.
function isMonitoredChannel(channelId) {
  return config.monitoredChannelIds.includes(channelId);
}

// A member is considered compliant when either their camera is on or they are screen sharing.
function isCompliant(voiceState) {
  return Boolean(voiceState?.selfVideo || voiceState?.streaming);
}

// Build a unique map key for one member inside one guild.
function getTimerKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

// Cancel and remove any existing countdown for this member.
function clearMemberTimer(guildId, userId) {
  const key = getTimerKey(guildId, userId);
  const existing = pendingChecks.get(key);
  if (existing) {
    clearTimeout(existing.warningTimeoutId);
    clearTimeout(existing.enforceTimeoutId);
    pendingChecks.delete(key);
    log(
      "debug",
      `Cleared pending timers for user ${userId} in guild ${guildId}`,
    );
  }
}

// Optionally DM the member so they know why the bot may move them soon.
async function sendWarningDm(member, channelName) {
  if (!config.dmWarnings) return;
  // const remainingSeconds = Math.floor(
  //   (config.gracePeriodMs - config.delayWarning) / 1000,
  // );
  const message = [
    `Oi ${member.user.username}!`,
    `O canal de voz **${channelName}** exige que você ative a câmera ou o compartilhamento de tela.`,
    `Por favor, ative um deles dentro de **2 minutos**, ou será movido(a) para o canal de espera.`,
  ].join("\n");
  try {
    await member.send(message);
  } catch (error) {
    log("warn", `Could not DM ${member.user.tag}; continuing anyway.`);
  }
}

// Final enforcement step after the grace period ends.
async function enforceMember(member) {
  const voiceState = member.voice;
  const currentChannel = voiceState?.channel;
  if (!currentChannel) return;
  if (!isMonitoredChannel(currentChannel.id)) return;
  if (isCompliant(voiceState)) return;

  const me = member.guild.members.me;
  if (!me) {
    log("error", "Bot guild member object was not available.");
    return;
  }

  const idleChannel = member.guild.channels.cache.get(config.idleChannelId);
  if (!idleChannel || idleChannel.type !== ChannelType.GuildVoice) {
    log("error", "IDLE_CHANNEL_ID does not point to a normal voice channel.");
    return;
  }

  const botPerms = currentChannel.permissionsFor(me);
  if (!botPerms?.has(PermissionsBitField.Flags.MoveMembers)) {
    log(
      "error",
      `Missing Move Members permission in channel ${currentChannel.name}.`,
    );
    return;
  }

  try {
    await member.voice.setChannel(
      idleChannel,
      "Camera or screen share not enabled in time",
    );
    log(
      "info",
      `Moved ${member.user.tag} from ${currentChannel.name} to ${idleChannel.name}`,
    );
  } catch (error) {
    log("error", `Failed to move ${member.user.tag}`, error);
  }
}

// Start or restart the grace-period timer for a member in a monitored voice channel.
async function scheduleEnforcement(member, channel) {
  const key = getTimerKey(member.guild.id, member.id);
  const existing = pendingChecks.get(key);

  if (existing) {
    // If a timer exists for THIS exact channel, let it keep ticking.
    if (existing.channelId === channel.id) return;
    // If they moved to a DIFFERENT monitored channel, clear the old timers.
    clearMemberTimer(member.guild.id, member.id);
  }

  // If they are compliant, ensure no stray timers exist and exit.
  if (isCompliant(member.voice)) {
    clearMemberTimer(member.guild.id, member.id);
    log("debug", `${member.user.tag} is already compliant in ${channel.name}`);
    return;
  }

  log(
    "info",
    `Started ${config.gracePeriodMs / 1000}s timer for ${member.user.tag} in ${channel.name}`,
  );

  // 1. Set the timer for the Warning DM (30 seconds)
  const warningTimeoutId = setTimeout(async () => {
    // Double check if they haven't become compliant or left in the last 30 seconds
    const currentMember = await member.guild.members
      .fetch(member.id)
      .catch(() => null);
    if (
      currentMember &&
      currentMember.voice.channelId === channel.id &&
      !isCompliant(currentMember.voice)
    ) {
      await sendWarningDm(member, channel.name);
    }
  }, config.delayWarning);

  // 2. Set the timer for the actual Kick/Move (Grace Period)
  const enforceTimeoutId = setTimeout(async () => {
    clearMemberTimer(member.guild.id, member.id);
    await enforceMember(member);
  }, config.gracePeriodMs);

  // Store BOTH timeout IDs so we can cancel them if the user turns on their camera
  pendingChecks.set(key, {
    warningTimeoutId,
    enforceTimeoutId,
    channelId: channel.id,
    startedAt: Date.now(),
  });
}

// Re-scan monitored channels on an interval so the bot stays reliable after restarts.
async function periodicAudit() {
  const guild = await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) {
    log("error", "Could not fetch the configured guild during periodic audit.");
    return;
  }

  for (const channelId of config.monitoredChannelIds) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) continue;

    for (const member of channel.members.values()) {
      if (member.user.bot) continue;

      if (isCompliant(member.voice)) {
        clearMemberTimer(guild.id, member.id);
      } else {
        await scheduleEnforcement(member, channel);
      }
    }
  }
}

// Run once after the bot logs in successfully.
client.once("ready", async () => {
  log("info", `Logged in as ${client.user.tag}`);
  log("info", `Monitoring ${config.monitoredChannelIds.length} channel(s)`);
  await periodicAudit();
  setInterval(periodicAudit, config.checkIntervalMs);
});

// Fired whenever someone joins, leaves, changes channel, starts camera, or starts/stops streaming.
client.on("voiceStateUpdate", async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  if (!newChannelId) {
    clearMemberTimer(member.guild.id, member.id);
    return;
  }

  if (
    newChannelId &&
    isMonitoredChannel(newChannelId) &&
    oldChannelId !== newChannelId
  ) {
    await scheduleEnforcement(member, newState.channel);
    return;
  }

  if (
    oldChannelId &&
    isMonitoredChannel(oldChannelId) &&
    !isMonitoredChannel(newChannelId)
  ) {
    clearMemberTimer(member.guild.id, member.id);
    return;
  }

  if (
    newChannelId &&
    isMonitoredChannel(newChannelId) &&
    isCompliant(newState)
  ) {
    clearMemberTimer(member.guild.id, member.id);
    log(
      "info",
      `${member.user.tag} is now compliant in ${newState.channel.name}`,
    );
    return;
  }

  if (
    newChannelId &&
    isMonitoredChannel(newChannelId) &&
    !isCompliant(newState)
  ) {
    await scheduleEnforcement(member, newState.channel);
  }
});

// Log unexpected promise errors instead of failing silently.
process.on("unhandledRejection", (error) => {
  log("error", "Unhandled promise rejection", error);
});

// Log unexpected synchronous errors too.
process.on("uncaughtException", (error) => {
  log("error", "Uncaught exception", error);
});

// Validate settings before attempting login.
validateConfig();

// Connect the bot to Discord using the bot token.
client.login(config.token);

const http = require('http');
const port = 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Stector is awake bro!');
})

server.listen(port, () => {
  log('info', `Keep-alive web server is running on port ${port}`);
});

