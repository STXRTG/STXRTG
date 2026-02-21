require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { db } = require('./index');
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const commands = [
    {
        name: 'stats',
        description: 'View the live telemetry statistics for all mods!',
    },
    {
        name: 'admin',
        description: 'Access the restricted Admin Analytics Dashboard.',
    }
];
client.once('ready', async () => {
    console.log(`Discord Bot Logged in as ${client.user.tag}!`);
    let showLive = true;
    const updatePresence = async () => {
        if (showLive) {
            try {
                const res = await db.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '5 minutes'`);
                const count = parseInt(res.rows[0].count, 10);
                client.user.setPresence({
                    activities: [{ name: `${count} Players`, type: 3 }],
                    status: 'dnd',
                });
            } catch (err) { }
        } else {
            try {
                const res = await db.query(`SELECT COUNT(*) as count FROM users`);
                const count = parseInt(res.rows[0].count, 10);
                client.user.setPresence({
                    activities: [{ name: `${count} Installs`, type: 3 }],
                    status: 'dnd',
                });
            } catch (err) { }
        }
        showLive = !showLive;
    };
    updatePresence();
    setInterval(updatePresence, 60 * 1000);
    console.log('Registering slash commands...');
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
        for (const [guildId, guild] of client.guilds.cache) {
            await rest.put(
                Routes.applicationGuildCommands(client.user.id, guildId),
                { body: commands }
            );
            console.log(`Successfully synced commands instantly to server ID: ${guildId}`);
        }
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('Successfully registered commands globally.');
    } catch (error) {
        console.error('Failed to register commands:', error);
    }
});
client.on('interactionCreate', async interaction => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'stats') {
            await interaction.deferReply();
            buildAndSendStatsEmbed(interaction, false);
        }
        if (interaction.commandName === 'admin') {
            const modal = new ModalBuilder()
                .setCustomId('adminLoginModal')
                .setTitle('Admin Authentication');
            const passwordInput = new TextInputBuilder()
                .setCustomId('adminPasswordInput')
                .setLabel("Enter Administrator Password:")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            const firstActionRow = new ActionRowBuilder().addComponents(passwordInput);
            modal.addComponents(firstActionRow);
            await interaction.showModal(modal);
        }
    }
    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'adminLoginModal') {
            const password = interaction.fields.getTextInputValue('adminPasswordInput');
            if (password === process.env.ADMIN_PASSWORD) {
                await interaction.deferReply({ ephemeral: true });
                buildAndSendStatsEmbed(interaction, true);
            } else {
                await interaction.reply({ content: '❌ Incorrect password. Access denied.', ephemeral: true });
            }
        }
    }
});
async function buildAndSendStatsEmbed(interaction, isAdmin) {
    try {
        const userRes = await db.query('SELECT COUNT(*) as count FROM users');
        const totalPlayers = parseInt(userRes.rows[0].count, 10);

        const liveRes = await db.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '5 minutes'`);
        const livePlayers = parseInt(liveRes.rows[0].count, 10);

        if (isAdmin) {
            const dauRes = await db.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '24 hours'`);
            const dau = dauRes.rows.length ? parseInt(dauRes.rows[0].count, 10) : 0;

            const rowsRes = await db.query(`
                SELECT 
                    mod_name, 
                    COUNT(*) as total_users, 
                    SUM(CASE WHEN last_used >= NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as active_24h 
                FROM mod_usage 
                GROUP BY mod_name 
                ORDER BY active_24h DESC, total_users DESC
            `);
            const rows = rowsRes.rows;

            sendEmbed(interaction, totalPlayers, livePlayers, dau, rows, true);
        } else {
            const rowsRes = await db.query('SELECT mod_name, COUNT(*) as count FROM mod_usage GROUP BY mod_name ORDER BY count DESC');
            const rows = rowsRes.rows;
            sendEmbed(interaction, totalPlayers, livePlayers, null, rows, false);
        }
    } catch (err) {
        console.error(err);
        return interaction.editReply('An error occurred fetching the database.');
    }
}
function sendEmbed(interaction, totalPlayers, livePlayers, dau, rows, isAdmin) {
    const embed = new EmbedBuilder()
        .setTitle(isAdmin ? '🛡️ Admin Telemetry Dashboard' : '📊 Mod Analytics Live Stats')
        .setColor(isAdmin ? '#ef4444' : '#10b981')
        .setThumbnail(client.user.displayAvatarURL())
        .setDescription(`Tracking **${totalPlayers}** total unique players across the ecosystem!`)
        .addFields({ name: '🟢 Live Online Now', value: `**${livePlayers}** player${livePlayers === 1 ? '' : 's'} active` })
        .setTimestamp();
    if (isAdmin) {
        embed.addFields({ name: 'Daily Active Users (24H)', value: `**${dau}** unique users online today` });
    }
    if (rows && rows.length === 0) {
        embed.addFields({ name: 'Mods', value: 'No data yet...' });
    } else {
        let modText = '';
        rows.forEach(r => {
            if (isAdmin) {
                const active24h = r.active_24h || 0;
                modText += `**${r.mod_name}**: ${r.total_users} Users | (+${active24h} Today)\n`;
            } else {
                modText += `**${r.mod_name}**: ${r.count || r.total_users} users\n`;
            }
        });
        embed.addFields({ name: isAdmin ? 'Detailed Mod Analytics' : 'Usage by Mod', value: modText });
    }
    interaction.editReply({ embeds: [embed] });
}
function startBot() {
    if (process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN !== 'your_discord_bot_token_here') {
        client.login(process.env.DISCORD_TOKEN).catch(console.error);
    } else {
        console.log('Skipping Discord Bot login: No valid DISCORD_TOKEN found in .env');
    }
}
module.exports = { startBot };
