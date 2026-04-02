/**
 * generate-facts.js
 * 
 * Calls the Anthropic Claude API to generate fresh solar/community solar
 * facts for the Cuidando Los Niños dashboard bottom bar.
 * 
 * Runs via GitHub Actions on a schedule (e.g., daily).
 * Writes output to public/facts.json.
 * 
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const fs = require('fs');
const https = require('https');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OUTPUT_PATH = './public/facts.json';
const NUM_FACTS = 30;

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY not set — skipping fact generation');
  process.exit(0); // Exit cleanly so the workflow doesn't fail
}

const prompt = `Generate exactly ${NUM_FACTS} interesting, educational facts about solar energy, community solar programs, and renewable energy. These will be displayed one at a time on a public kiosk dashboard for a community solar project in Belen, New Mexico (operated by Affordable Solar Group).

Requirements:
- Each fact must be a single sentence, suitable for display in a bottom ticker bar
- Use <strong>bold tags</strong> around the most impactful number or phrase in each fact (exactly one per fact)
- Mix topics: solar science, community solar benefits, New Mexico solar resources, environmental impact, solar economics, solar history, fun comparisons
- Keep language accessible for a general audience (including school children)
- Be accurate — no made-up statistics
- Don't start every fact the same way — vary sentence structure
- No numbered lists or bullet points — just the fact text
- Avoid mentioning specific companies other than general references to "community solar" or "this project"

Return ONLY a valid JSON array of strings, no markdown, no explanation. Example format:
["Fact one with <strong>bold part</strong>", "Fact two with <strong>bold part</strong>"]`;

function callClaude() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API returned ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || '';
          resolve(text);
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log('Generating fresh solar facts via Claude API...');
  
  try {
    const text = await callClaude();
    
    // Extract JSON array from response (handle potential markdown wrapping)
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    
    const facts = JSON.parse(jsonStr);
    
    if (!Array.isArray(facts) || facts.length < 5) {
      throw new Error('Expected array of facts, got: ' + typeof facts);
    }
    
    // Validate each fact is a non-empty string
    const valid = facts.filter(f => typeof f === 'string' && f.length > 10);
    
    if (valid.length < 5) {
      throw new Error('Too few valid facts: ' + valid.length);
    }
    
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(valid, null, 2));
    console.log(`Wrote ${valid.length} facts to ${OUTPUT_PATH}`);
    
  } catch (e) {
    console.error('Fact generation failed:', e.message);
    // Don't overwrite existing facts.json on failure
    if (fs.existsSync(OUTPUT_PATH)) {
      console.log('Keeping existing facts.json');
    } else {
      console.log('No existing facts.json — workflow will use hardcoded fallback');
    }
    process.exit(0); // Exit cleanly
  }
}

main();
