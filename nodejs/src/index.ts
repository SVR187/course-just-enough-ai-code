import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import pkg from 'pg'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import fetch from 'node-fetch'

dotenv.config()

const { Pool } = pkg
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = new Hono()

// Database connection
const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
})

// Cloudflare API Configuration
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN
const CLOUDFLARE_EMBEDDING_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-base-en-v1.5`

// Function to run migrations
async function runMigrations() {
    try {
        const migrationSQL = fs.readFileSync(
            path.join(__dirname, '../db/migrations.sql'),
            'utf8'
        )
        await pool.query(migrationSQL)
        console.log('Migrations completed successfully')
    } catch (error) {
        console.error('Error running migrations:', error)
        throw error
    }
}

// Serve static files
app.get('/', serveStatic({ path: './index.html' }))

// Search API
app.get('/search', (c) => {
    const results = [
        {
            doc: {
                title: "Test Document 1",
                content: "This is the content of Test Document 1"
            },
            similarity_score: 0.92
        },
        {
            doc: {
                title: "Test Document 2",
                content: "This is the content of Test Document 2"
            },
            similarity_score: 0.85
        }
    ]
    return c.json(results)
})

// Insert data API
app.get('/insert', async (c) => {
    try {
        const title = "hello"
        const content = "hello"
        const embedding = null  // Initially set embedding to null since it's optional
        
        if (!title || !content) {
            return c.json({ error: 'Title and content are required' }, 400)
        }

        const query = `
            INSERT INTO documents (title, content, embedding)
            VALUES ($1, $2, $3)
            RETURNING id, title, content
        `
        const result = await pool.query(query, [title, content, embedding])
        
        return c.json({
            message: 'Document inserted successfully',
            document: result.rows[0]
        })
    } catch (error) {
        console.error('Error inserting document:', error)
        return c.json({ error: 'Failed to insert document' }, 500)
    }
})

console.log("Starting server...")

// Generate embeddings API
app.post('/generate_embeddings', async (c) => {
    try {
        let requestData;
        
        try {
            requestData = await c.req.json();
        } catch (error) {
            console.warn("Request body is missing or invalid. Using default text.");
            requestData = { text: ["Default text for embedding"] };
        }

        const { text } = requestData;

        // Ensure text is always valid
        if (!text || (Array.isArray(text) && text.length === 0)) {
            return c.json({ error: "Text input is required." }, 400);
        }

        const response = await fetch(CLOUDFLARE_EMBEDDING_URL, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${CLOUDFLARE_API_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text }),
        });

        // Debugging: Check if response is empty or not JSON
        const responseText = await response.text();
        console.log("Cloudflare Response:", responseText);  // Debugging

        if (!response.ok) {
            return new Response(JSON.stringify({ error: "Cloudflare API error", details: responseText }), {
                status: response.status,
                headers: { "Content-Type": "application/json" }
            });            
        }

        // Parse JSON only if response contains valid JSON
        let result;
        try {
            result = JSON.parse(responseText);
        } catch (jsonError) {
            console.error("JSON Parsing Error:", jsonError);
            return c.json({ error: "Invalid JSON response from Cloudflare", details: responseText }, 500);
        }

        return c.json({
            message: `Generated embeddings for ${Array.isArray(text) ? text.length : 1} document(s)`,
            embeddings: result.result,
        });

    } catch (error) {
        console.error("Embedding generation error:", error);
        return c.json({ error: "Failed to generate embeddings.", details: error.message }, 500);
    }
})

// Initialize database and start server
async function initialize() {
    try {
        await runMigrations()
        serve(app, (info) => {
            console.log(`Server running at http://localhost:${info.port}`)
        })
    } catch (error) {
        console.error('Failed to initialize:', error)
        process.exit(1)
    }
}

initialize()