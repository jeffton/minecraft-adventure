// Credential comes from the root-owned environment file, never arguments/output.
let body = '';
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
if (!process.env.PLANNER_RELAY_TOKEN) throw new Error('Missing server relay credential');
const response = await fetch('http://127.0.0.1:8766/operator/task', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.PLANNER_RELAY_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(input),
});
const result = await response.json();
if (!response.ok) throw new Error(`Operator request failed (${response.status}): ${result.error}`);
console.log(JSON.stringify(result));
