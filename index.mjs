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
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// In-memory per-guild config (fallbacks to .env). For persistence later, we can write/read a JSON file.
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
    if (!perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) return null;
    return ch;
  } catch {
    return null;
  }
}
async function safeSend(channel, content) {
  if (!channel) return;
  try { await channel.send(content); } catch (err) { console.error('Log send failed:', err?.code || err?.message || err); }
}
async function setVip(member, shouldHave, logChannel) {
  const { vipRoleId } = getCfg(member.guild);
  if (!vipRoleId) { await safeSend(logChannel, `⚠️ VIP role not configured. Use /setup or /setviprole.`); return; }
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
  if (!vipRoleId) { await safeSend(logChannel, `⚠️ VIP role not configured. Use /setup or /setviprole.`); return { added: 0, removed: 0, total: 0 }; }
  const members = await guild.members.fetch(); // requires Server Members Intent
  let added = 0, removed = 0;
  for (const member of members.values()) {
    const shouldHave = Boolean(member.premiumSince);
    const had = member.roles.cache.has(vipRoleId);
    if (shouldHave && !had) { await setVip(member, true, logChannel); added++; }
    else if (!shouldHave && had) { await setVip(member, false, logChannel); removed++; }
  }
  return { added, removed, total: members.size };
}

// ---------- lifecycle ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'Boosting in style' }], status: 'online' }); // presence best practice :contentReference[oaicite:4]{index=4}

  // Slash commands (per-guild for fast propagation) :contentReference[oaicite:5]{index=5}
  const commandDef = [
    { name: 'reconcile', description: 'Scan all members and fix VIP role based on boost status', type: ApplicationCommandType.ChatInput },
    {
      name: 'setlog',
      description: 'Set the log channel',
      type: ApplicationCommandType.ChatInput,
      default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
      options: [{ name: 'channel', description: 'Text channel for logs', type: ApplicationCommandOptionType.Channel, required: true,
        channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread] }],
    },
    {
      name: 'setviprole',
      description: 'Set the VIP role for boosters',
      type: ApplicationCommandType.ChatInput,
      default_member_permissions: String(PermissionsBitField.Flags.ManageRoles),
      options: [{ name: 'role', description: 'Role to grant boosters', type: ApplicationCommandOptionType.Role, required: true }],
    },
    { name: 'setup', description: 'Open the BoostBot setup wizard', type: ApplicationCommandType.ChatInput },
  ];
  for (const [, guild] of client.guilds.cache) {
    try {
      await guild.commands.set(commandDef);
      setTimeout(async () => {
        try {
          const stats = await reconcileGuild(guild);
          const logCh = await getLogChannel(guild);
          await safeSend(logCh, `🧹 Initial reconcile: VIP added ${stats.added}, removed ${stats.removed}, checked ${stats.total}.`);
        } catch (e) { console.error('Initial reconcile error:', e); }
      }, 5_000);
    } catch (e) { console.error(`Failed to register commands for ${guild.name}:`, e); }
  }
});

// ---------- interactions (slash + components) ----------
client.on(Events.InteractionCreate, async (interaction) => {
  // slash: /reconcile
  if (interaction.isChatInputCommand() && interaction.commandName === 'reconcile') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const stats = await reconcileGuild(interaction.guild);
      await interaction.editReply(`✅ Reconcile complete: VIP added **${stats.added}**, removed **${stats.removed}**, checked **${stats.total}**.`);
    } catch (e) { console.error('Reconcile command error:', e); await interaction.editReply('❌ Reconcile failed.'); }
    return;
  }

  // slash: /setlog
  if (interaction.isChatInputCommand() && interaction.commandName === 'setlog') {
    const ch = interaction.options.getChannel('channel', true);
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

  // slash: /setviprole
  if (interaction.isChatInputCommand() && interaction.commandName === 'setviprole') {
    const role = interaction.options.getRole('role', true);
    const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
    if (role.position >= me.roles.highest.position) {
      await interaction.reply({ content: '❌ That role is above (or equal to) my highest role. Move my role above it, then try again.', ephemeral: true });
      return;
    }
    getCfg(interaction.guild).vipRoleId = role.id;
    await interaction.reply({ content: `✅ VIP role set to **${role.name}**.`, ephemeral: true });
    return;
  }

  // slash: /setup  → show wizard (select menus + Save button)
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    const cfg = getCfg(interaction.guild);

    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('setup:channel')
      .setPlaceholder('Select a log channel')
      .setChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread)
      .setMinValues(1).setMaxValues(1);

    const roleSelect = new RoleSelectMenuBuilder()
      .setCustomId('setup:role')
      .setPlaceholder('Select the VIP role')
      .setMinValues(1).setMaxValues(1);

    const saveBtn = new ButtonBuilder()
      .setCustomId('setup:save')
      .setLabel('Save & Validate')
      .setStyle(ButtonStyle.Success);

    const row1 = new ActionRowBuilder().addComponents(channelSelect);
    const row2 = new ActionRowBuilder().addComponents(roleSelect);
    const row3 = new ActionRowBuilder().addComponents(saveBtn);

    await interaction.reply({
      ephemeral: true,
      content:
        `**BoostBot Setup Wizard**\n` +
        `• Log channel: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '_not set_'}\n` +
        `• VIP role: ${cfg.vipRoleId ? `<@&${cfg.vipRoleId}>` : '_not set_'}\n\n` +
        `Pick a channel & role, then click **Save & Validate**.`,
      components: [row1, row2, row3],
    });
    return;
  }

  // Component: selects + Save button
  if (interaction.isAnySelectMenu() || interaction.isButton()) {
    // Channel chosen
    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup:channel') {
      const chosen = interaction.values[0];
      getCfg(interaction.guild).logChannelId = chosen;
      await interaction.update({ content: `✅ Log channel selected: <#${chosen}>\nNow pick a VIP role and hit **Save & Validate**.`, components: interaction.message.components });
      return;
    }
    // Role chosen
    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup:role') {
      const chosen = interaction.values[0];
      getCfg(interaction.guild).vipRoleId = chosen;
      await interaction.update({ content: `✅ VIP role selected: <@&${chosen}>\nNow pick a log channel (if you haven’t) and hit **Save & Validate**.`, components: interaction.message.components });
      return;
    }
    // Save & Validate
    if (interaction.isButton() && interaction.customId === 'setup:save') {
      const cfg = getCfg(interaction.guild);
      if (!cfg.logChannelId || !cfg.vipRoleId) {
        await interaction.reply({ ephemeral: true, content: '❌ Please select **both** a log channel and a VIP role first.' });
        return;
      }
      const me = interaction.guild.members.me ?? (await interaction.guild.members.fetchMe());
      const role = interaction.guild.roles.cache.get(cfg.vipRoleId);
      if (!role) { await interaction.reply({ ephemeral: true, content: '❌ That VIP role no longer exists. Pick a different one.' }); return; }
      if (role.position >= me.roles.highest.position) {
        await interaction.reply({ ephemeral: true, content: '❌ My top role is not higher than the VIP role. Move my role up, then try again.' });
        return;
      }
      // Channel permissions check
      const ch = await interaction.guild.channels.fetch(cfg.logChannelId).catch(() => null);
      const perms = ch?.permissionsFor(me);
      if (!ch?.isTextBased() || !perms?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) {
        await interaction.reply({ ephemeral: true, content: '❌ I can’t send messages in the selected log channel. Fix its permissions and try again.' });
        return;
      }
      // All good
      await interaction.reply({ ephemeral: true, content: `✅ Setup complete! Logs → ${ch}, VIP role → **${role.name}**.` });
      const logCh = await getLogChannel(interaction.guild);
      await safeSend(logCh, '🛠️ Setup complete. BoostBot is configured and ready.');
      return;
    }
  }
});

// Boost start/stop via premiumSince change (guildMemberUpdate) :contentReference[oaicite:6]{index=6}
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
