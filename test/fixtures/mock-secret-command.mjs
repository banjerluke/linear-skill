const value = process.env.MOCK_SECRET_COMMAND_VALUE;

if (!value) {
  console.error('Mock secret is unavailable');
  process.exit(1);
}

console.log(JSON.stringify({ value }));
