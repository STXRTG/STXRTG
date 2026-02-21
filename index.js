require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                hashed_uuid TEXT UNIQUE,
                first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS mod_usage (
                user_id INTEGER,
                mod_name TEXT,
                last_used TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (user_id, mod_name),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        `);
    } catch (err) {
        console.error("Error initializing database:", err);
    }
}

initDb();

const trackerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Too many requests, please try again later.' }
});

app.post('/api/track', trackerLimiter, async (req, res) => {
    const { hashed_uuid, mod_name } = req.body;

    if (!hashed_uuid || !mod_name) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        await pool.query(`
            INSERT INTO users (hashed_uuid) 
            VALUES ($1)
            ON CONFLICT (hashed_uuid) DO UPDATE SET last_seen = CURRENT_TIMESTAMP
        `, [hashed_uuid]);

        const userRes = await pool.query('SELECT id FROM users WHERE hashed_uuid = $1', [hashed_uuid]);

        if (userRes.rows.length === 0) return res.status(500).json({ error: 'Database error' });

        const userId = userRes.rows[0].id;

        await pool.query(`
            INSERT INTO mod_usage (user_id, mod_name) 
            VALUES ($1, $2)
            ON CONFLICT (user_id, mod_name) DO UPDATE SET last_used = CURRENT_TIMESTAMP
        `, [userId, mod_name]);

        res.status(200).json({ success: true });
    } catch (err) {
        console.error('Error tracking user/mod:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const realPassword = process.env.ADMIN_PASSWORD;

    if (!realPassword) {
        return res.status(500).json({ success: false, error: 'Admin password not configured on server' });
    }

    if (password === realPassword) {
        res.json({ success: true, token: 'admin_session_valid' });
    } else {
        res.status(401).json({ success: false, error: 'Invalid password' });
    }
});

app.get('/api/stats', async (req, res) => {
    const stats = {
        total_unique_players: 0,
        live_players: 0,
        daily_active_users: 0,
        dau_trend_pct: 0,
        total_pings_24h: 0,
        mods: {}
    };

    try {
        const totalUsersRes = await pool.query('SELECT COUNT(*) as count FROM users');
        stats.total_unique_players = parseInt(totalUsersRes.rows[0].count, 10);

        const dauRes = await pool.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '24 hours'`);
        stats.daily_active_users = parseInt(dauRes.rows[0].count, 10);

        const prevDauRes = await pool.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '48 hours' AND last_seen < NOW() - INTERVAL '24 hours'`);
        let prev = parseInt(prevDauRes.rows[0].count, 10);

        if (prev === 0) {
            stats.dau_trend_pct = stats.daily_active_users > 0 ? 100 : 0;
        } else {
            stats.dau_trend_pct = Math.round(((stats.daily_active_users - prev) / prev) * 100);
        }

        const liveRes = await pool.query(`SELECT COUNT(*) as count FROM users WHERE last_seen >= NOW() - INTERVAL '5 minutes'`);
        stats.live_players = parseInt(liveRes.rows[0].count, 10);

        const modRes = await pool.query(`
            SELECT 
                mod_name, 
                COUNT(*) as total_users,
                SUM(CASE WHEN last_used >= NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END) as active_24h
            FROM mod_usage 
            GROUP BY mod_name
        `);

        let total24hPings = 0;
        modRes.rows.forEach(r => {
            const active24h = parseInt(r.active_24h || 0, 10);
            stats.mods[r.mod_name] = {
                total: parseInt(r.total_users, 10),
                active_24h: active24h
            };
            total24hPings += active24h;
        });

        stats.total_pings_24h = total24hPings;

        res.json(stats);
    } catch (error) {
        console.error("Error fetching stats:", error);
        res.status(500).json({ error: 'Database error' });
    }
});

app.listen(PORT, () => {
    console.log(`Analytics API Server running on port ${PORT}`);
    const bot = require('./bot');
    bot.startBot();
});

module.exports = {
    db: pool
};