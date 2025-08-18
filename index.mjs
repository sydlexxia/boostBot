console.log('boostBot starting...');
import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  PermissionsBitField,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  ChannelType,
} from 'discord.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// In-memory per-guild config with env fallbacks
const guildConfig = new Map(); // guildId -> { logChannelId, vipRoleId }

function getCfg(guild) {
  const cfg = guildConfig.get(guild.id) ?? {
    logChannelId: process.env.LOG_CHANNEL_ID ?? null,
    vipRoleId: process.env.VIP_ROLE_ID ?? null,
  };
  guildConfig.set(guild.id, cfg);
  return cfg;
}

// ---------- utilities ----------

async function getLogChannel(guild) {
  const { logChannelId } = getCfg(guild);
  if (!logChannelId) return null;
  try {
    const ch = await guild.channels.fetch(logChannelId);
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

async function safeSend(channel, content) {
  if (!channel) return;
  try {
    await channel.send(content);
  } catch (err) {
    console.error('Log send failed:', err?.code || err?.message || err);
  }
}

async function setVip(member, shouldHave, logChannel) {
  const { vipRoleId } = getCfg(member.guild);
  if (!vipRoleId) {
    await safeSend(logChannel, `⚠️ VIP role not configured. Use /setviprole first.`);
    return;
  }
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

async function reconcileGuild(guild) {
  const logChannel = await getLogChannel(guild);
  const { vipRoleId } = getCfg(guild);
  if (!vipRoleId) {
    await safeSend(logChannel, `⚠️ VIP role not configured. Use /setviprole first.`);
    return { added: 0, removed: 0, total: 0 };
  }

  const members = await guild.members.fetch(); // requires Server Members Intent
  let added = 0, removed = 0;

  for (const member of members.values()) {
    const shouldHave = Boolean(member.premiumSince);
    const had = member.roles.cache.has(vipRoleId);
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

// ---------- lifecycle ----------

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  client.user.setPresence({
    activities: [{ name: 'Boosting in style' }],
    status: 'online',
  });

  // Register slash commands per guild for quick dev
  const commandDef = [
    {
      name: 'reconcile',
      description: 'Scan all members and fix VIP role based on current boost status',
      type: ApplicationCommandType.ChatInput,
    },
    {
      name: 'setlog',
      description: 'Set the log channel where BoostBot posts updates',
      type: ApplicationCommandType.ChatInput,
      default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
      options: [
        {
          name: 'channel',
          description: 'Text channel for logs',
          type: ApplicationCommandOptionType.Channel,
          channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread],
          required: true,
        },
      ],
    },
    {
      name: 'setviprole',
      description: 'Set the VIP role given to server boosters',
      type: ApplicationCommandType.ChatInput,
      default_member_permissions: String(PermissionsBitField.Flags.ManageRoles),
      options: [
        {
          name: 'role',
          description: 'Role to grant boosters',
          type: ApplicationCommandOptionType.Role,
          required: true,
        },
      ],
    },
  ];

  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.commands.set(commandDef); // per-guild register (fast propagation)
      // initial staggered reconcile
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

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'reconcile') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const stats = await reconcileGuild(interaction.guild);
      await interaction.editReply(`✅ Reconcile complete: VIP added **${stats.added}**, removed **${stats.removed}**, checked **${stats.total}**.`);
    } catch (e) {
      console.error('Reconcile command error:', e);
      await interaction.editReply('❌ Reconcile failed. Check logs for details.');
    }
    return;
  }

  if (interaction.commandName === 'setlog') {
    const ch = interaction.options.getChannel('channel', true);
    // Validate that bot can see/send
    const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    const perms = ch.permissionsFor(me);
    if (!perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) {
      await interaction.reply({ content: '❌ I can’t send messages in that channel. Adjust its permissions and try again.', ephemeral: true });
      return;
    }
    getCfg(interaction.guild).logChannelId = ch.id;
    await interaction.reply({ content: `✅ Log channel set to ${ch}.`, ephemeral: true });
    return;
  }

  if (interaction.commandName === 'setviprole') {
    const role = interaction.options.getRole('role', true);
    // Ensure hierarchy allows assignment
    const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    const myTop = me.roles.highest?.position ?? 0;
    if (role.position >= myTop) {
      await interaction.reply({ content: '❌ That role is above (or equal to) my highest role. Move my role above it, then try again.', ephemeral: true });
      return;
    }
    getCfg(interaction.guild).vipRoleId = role.id;
    await interaction.reply({ content: `✅ VIP role set to **${role.name}**.`, ephemeral: true });
    return;
  }
});

// Boost start/stop via premiumSince changes
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  const oldBoost = oldMember.premiumSince;
  const newBoost = newMember.premiumSince;
  if (oldBoost === newBoost) return;

  const logChannel = await getLogChannel(newMember.guild);
  const isBoostingNow = Boolean(newBoost);
  await setVip(newMember, isBoostingNow, logChannel);
});

process.on('unhandledRejection', (err) => console.error('unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('uncaughtException', err));

client.login(process.env.DISCORD_TOKEN);
