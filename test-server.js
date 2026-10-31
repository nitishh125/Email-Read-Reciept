const http = require('http');
const { app, server } = require('./server');

async function request(options, postData) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(data);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body.toString(),
          rawBody: body,
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runTests() {
  const address = server.address();
  const port = address.port;
  console.log(`Testing server on port ${port}...`);

  try {
    // 1. Test GET /
    const resHome = await request({
      hostname: 'localhost',
      port,
      path: '/',
      method: 'GET',
    });
    console.log('GET / -> Status:', resHome.statusCode);
    if (resHome.statusCode !== 200 || !resHome.body.includes('READ')) {
      throw new Error('Failed GET /');
    }
    console.log('✔ GET / succeeded');

    // 2. Test GET /api/emails
    const resListEmpty = await request({
      hostname: 'localhost',
      port,
      path: '/api/emails',
      method: 'GET',
    });
    console.log('GET /api/emails -> Status:', resListEmpty.statusCode);
    const initialEmails = JSON.parse(resListEmpty.body);
    console.log('Initial email count:', initialEmails.length);
    console.log('✔ GET /api/emails succeeded');

    // 3. Test POST /api/emails
    const newEmailData = JSON.stringify({
      recipient: 'test@example.com',
      subject: 'Interview Confirmation',
    });
    const resCreate = await request({
      hostname: 'localhost',
      port,
      path: '/api/emails',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(newEmailData),
      },
    }, newEmailData);
    console.log('POST /api/emails -> Status:', resCreate.statusCode);
    const created = JSON.parse(resCreate.body);
    console.log('Created email ID:', created.id);
    if (resCreate.statusCode !== 201 || !created.id) {
      throw new Error('Failed POST /api/emails');
    }
    console.log('✔ POST /api/emails succeeded');

    // 4. Test tracking pixel GET /track/:id.png
    const resPixel = await request({
      hostname: 'localhost',
      port,
      path: `/track/${created.id}.png`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) TestBrowser',
      },
    });
    console.log('GET /track/:id.png -> Status:', resPixel.statusCode, 'Content-Type:', resPixel.headers['content-type']);
    if (resPixel.statusCode !== 200 || resPixel.headers['content-type'] !== 'image/png') {
      throw new Error('Failed GET /track/:id.png');
    }
    console.log('✔ GET /track/:id.png succeeded (pixel image returned)');

    // 5. Test that open event was recorded
    const resListAfter = await request({
      hostname: 'localhost',
      port,
      path: '/api/emails',
      method: 'GET',
    });
    const listAfter = JSON.parse(resListAfter.body);
    const trackedEmail = listAfter.find((e) => e.id === created.id);
    console.log('Open count for created email:', trackedEmail?.opens?.length);
    if (!trackedEmail || trackedEmail.opens.length !== 1) {
      throw new Error('Open event was not recorded!');
    }
    console.log('✔ Email open recorded successfully');

    // 6. Test compose filter (Referer: mail.google.com) - should NOT record an open
    const resCompose = await request({
      hostname: 'localhost',
      port,
      path: `/track/${created.id}.png`,
      method: 'GET',
      headers: {
        'Referer': 'https://mail.google.com/mail/u/0/#inbox?compose=new',
        'User-Agent': 'Mozilla/5.0 TestBrowser',
      },
    });
    console.log('GET /track/:id.png (with Gmail compose referer) -> Status:', resCompose.statusCode);
    const resListAfterCompose = await request({
      hostname: 'localhost',
      port,
      path: '/api/emails',
      method: 'GET',
    });
    const listAfterCompose = JSON.parse(resListAfterCompose.body);
    const trackedEmailAfterCompose = listAfterCompose.find((e) => e.id === created.id);
    if (trackedEmailAfterCompose.opens.length !== 1) {
      throw new Error('Compose request was incorrectly recorded as open!');
    }
    console.log('✔ Compose filter successfully ignored compose preview request');

    // 7. Test DELETE /api/emails
    const resDelete = await request({
      hostname: 'localhost',
      port,
      path: '/api/emails',
      method: 'DELETE',
    });
    console.log('DELETE /api/emails -> Status:', resDelete.statusCode);
    if (resDelete.statusCode !== 204) {
      throw new Error('Failed DELETE /api/emails');
    }
    console.log('✔ DELETE /api/emails succeeded');

    console.log('ALL TESTS PASSED SUCCESSFULLY! 🎉');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

runTests();
