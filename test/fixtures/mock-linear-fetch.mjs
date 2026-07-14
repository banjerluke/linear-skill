const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://api.linear.app/oauth/token') {
    const body = new URLSearchParams(init.body);
    const valid = body.get('grant_type') === 'client_credentials'
      && body.get('client_id') === process.env.MOCK_LINEAR_CLIENT_ID
      && body.get('client_secret') === process.env.MOCK_LINEAR_CLIENT_SECRET;
    if (!valid) return new Response('invalid client credentials request', { status: 400 });
    return Response.json({
      access_token: 'lin_oauth_mock_client_credentials',
      token_type: 'Bearer',
      expires_in: 2592000,
      scope: body.get('scope'),
    });
  }
  if (url === 'https://api.linear.app/graphql') {
    const authorization = new Headers(init.headers).get('authorization');
    if (authorization !== 'Bearer lin_oauth_mock_client_credentials') {
      return new Response('invalid access token', { status: 401 });
    }
    return Response.json({ data: { viewer: { id: 'mock-viewer' } } });
  }
  return originalFetch(input, init);
};
