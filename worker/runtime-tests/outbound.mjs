// This service is the only outbound destination in the local Workerd test.
const fixture = new URL('https://diagnostic-example.cloudflareaccess.com/cdn-cgi/access/certs');
let key;
let status = 200;
let jwksRequests = 0;
let openAIRequests = 0;

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === 'runtime-control.example.test') {
      if (request.method === 'PUT') ({ key, status } = await request.json());
      return Response.json({ jwksRequests, openAIRequests });
    }
    if (url.href === fixture.href) {
      jwksRequests++;
      if (status === 302) return Response.redirect('https://redirect-not-permitted.example.test/jwks');
      return Response.json({ keys: [key] });
    }
    if (url.href === 'https://api.openai.com/v1/responses') {
      openAIRequests++;
      return Response.redirect('https://redirect-not-permitted.example.test/responses');
    }
    throw new Error('Unexpected outbound URL in the offline Workerd test');
  },
};
