console.log('boostBot starting...');
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  PermissionsBitField,
  ApplicationCommandType,
} from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // needed for guildMemberUpdate + fetching members
  ],
});

/** ---------- utilities ---------- **/

// Resolve and permission-check the log channel; return null if unusable.
async function getLogChannel(guild) {
  const id = process.env.LOG_CHANNEL_ID;
  if (!id) return null;
  try {
    const ch = await guild.channels.fetch(id);
    if (!ch?.isTextBased()) return null;

    const me = guild.members.me ?? (await guild.members.fetchMe());
    const perms = ch.permissionsFor(me);
    if (!perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) {
      return null;
    }
    return ch;
  } catch {
    return null;
  }
}

// Safe send that never throws (prevents process crash on 50001 Missing Access).
async function safeSend(channel, content) {
  if (!channel) return;
  try {
    await channel.send(content);
  } catch (err) {
    // Common when bot lacks Send Messages or channel is hidden: 403 / 50001
    console.error('Log send failed:', err?.code || err?.message || err);
  }
}

// Utility: safe role add/remove with logging
async function setVip(member, shouldHave, logChannel) {
  const vipRoleId = process.env.VIP_ROLE_ID;
  if (!vipRoleId) return;

  const hasRole = member.roles.cache.has(vipRoleId);
  try {
    if (shouldHave && !hasRole) {
      await member.roles.add(vipRoleId, 'Started boosting');
      await safeSend(logChannel, `⭐ ${member} started boosting — VIP role added.`);
    } else if (!shouldHave && hasRole) {
      await member.roles.remove(vipRoleId, 'Stopped boosting');
      await safeSend(logChannel, `💤 ${member} stopped boosting — VIP role removed.`);
    }
  } catch (err) {
    await safeSend(logChannel, `⚠️ Role change failed for ${member}: ${err.message}`);
    console.error(err);
  }
}

// Reconcile a single guild: ensure VIP role matches boost status (premiumSince)
async function reconcileGuild(guild) {
  const logChannel = await getLogChannel(guild);
  const members = await guild.members.fetch(); // requires SERVER MEMBERS INTENT enabled in portal
  let added = 0, removed = 0;

  for (const member of members.values()) {
    const shouldHave = Boolean(member.premiumSince); // official field to detect current boosting
    const had = member.roles.cache.has(process.env.VIP_ROLE_ID);
    if (shouldHave && !had) {
      await setVip(member, true, logChannel);
      added++;
    } else if (!shouldHave && had) {
      await setVip(member, false, logChannel);
      removed++;
    }
  }
  return { added, removed, total: members.size };
}

/** ---------- lifecycle ---------- **/

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Presence so you appear online immediately
  client.user.setPresence({
    activities: [{ name: 'Boosting in style' }],
    status: 'online',
  }); // Presence setting is the supported way to show "online". :contentReference[oaicite:1]{index=1}

  // Register /reconcile per guild (fast dev cycle)
  // Requires applications.commands scope. :contentReference[oaicite:2]{index=2}
  const commandDef = [{
    name: 'reconcile',
    description: 'Scan all members and fix VIP role based on current boost status',
    type: ApplicationCommandType.ChatInput,
  }];

  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.commands.set(commandDef);
      // Stagger reconcile so we don’t hammer large guilds
      setTimeout(async () => {
        try {
          const stats = await reconcileGuild(guild);
          const logCh = await getLogChannel(guild);
          await safeSend(logCh, `🧹 Initial reconcile: VIP added ${stats.added}, removed ${stats.removed}, checked ${stats.total}.`);
        } catch (e) {
          console.error('Initial reconcile error:', e);
        }
      }, 5_000);
    } catch (e) {
      console.error(`Failed to register commands for ${guild.name}:`, e);
    }
  }
});

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'reconcile') return;

  await interaction.deferReply({ ephemeral: true });
  try {
    const stats = await reconcileGuild(interaction.guild);
    await interaction.editReply(`✅ Reconcile complete: VIP added **${stats.added}**, removed **${stats.removed}**, checked **${stats.total}**.`);
  } catch (e) {
    console.error('Reconcile command error:', e);
    await interaction.editReply('❌ Reconcile failed. Check logs for details.');
  }
});

// Core: watch for boost start/stop via premiumSince changes
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  // premiumSince is the supported field for when a member started boosting this guild. :contentReference[oaicite:3]{index=3}
  const oldBoost = oldMember.premiumSince;
  const newBoost = newMember.premiumSince;
  if (oldBoost === newBoost) return;

  const logChannel = await getLogChannel(newMember.guild);
  const isBoostingNow = Boolean(newBoost);
  await setVip(newMember, isBoostingNow, logChannel);
});

/** ---------- process hardening ---------- **/

process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('uncaughtException', err));

client.login(process.env.DISCORD_TOKEN);
