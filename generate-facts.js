// generate-facts.js — Uses Claude API (Haiku) to generate fresh solar facts
// Called by GitHub Actions on a schedule (e.g., daily)
// Writes to public/facts.json

const fs = require('fs');
const path = require('path');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OUTPUT_PATH = path.join(__dirname, 'public', 'facts.json');

const SYSTEM_PROMPT = `You are a solar energy expert writing short, engaging facts for a public kiosk display at a community solar project in Belen, New Mexico (Cuidando Los Niños Community Solar, 4.975 MW AC system provided by Affordable Solar Group).

Rules:
- Each fact must be ONE sentence, under 120 characters if possible (max 150)
- Use <strong> tags to emphasize the most impactful number or phrase in each fact
- Mix topics: solar science, NM solar resources, community solar benefits, environmental impact, solar industry stats, fun solar comparisons
- Be accurate — do not invent statistics
- Audience: school children and community members visiting a classroom
- Tone: inspiring, educational, accessible
- Do NOT repeat facts from previous batches if provided
- Return ONLY a JSON array of strings, no other text`;

async function generateFacts(existingFacts = []) {
  if (!ANTHROPIC_API_KEY) {
    console.log('No ANTHROPIC_API_KEY set — skipping fact generation');
    process.exit(0);
  }

  const userPrompt = existingFacts.length > 0
    ? `Generate 25 new solar energy facts. Here are the existing ones to avoid repeating:\n${JSON.stringify(existingFacts)}`
    : 'Generate 25 solar energy facts for a community solar kiosk display.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`API error ${response.status}: ${err}`);
    }

    const data = await response.json();
    const text = data.content[0].text.trim();

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in response');

    const facts = JSON.parse(jsonMatch[0]);

    if (!Array.isArray(facts) || facts.length === 0) {
      throw new Error('Empty or invalid facts array');
    }

    // Validate each fact is a string
    const valid = facts.filter(f => typeof f === 'string' && f.length > 10);
    console.log(`Generated ${valid.length} facts via Claude API`);

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(valid, null, 2));
    console.log(`Written to ${OUTPUT_PATH}`);

  } catch (err) {
    console.error('Fact generation failed:', err.message);
    // Don't overwrite existing facts.json on failure
    if (fs.existsSync(OUTPUT_PATH)) {
      console.log('Keeping existing facts.json');
    }
    process.exit(1);
  }
}

// Load existing facts to avoid repeats
let existing = [];
try {
  existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
} catch (e) { /* no existing file */ }

generateFacts(existing);
