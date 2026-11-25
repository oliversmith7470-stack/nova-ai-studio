// Minimal probe worker for the S-layer (SQL semantics) only.
// Holds the NOVA_DB binding so tests can drive D1 directly via
// mf.getD1Database(). Contains no application logic and is never the
// subject of any assertion. Used so S-layer results do not depend on
// _worker.js being parseable while the implementation workstream edits it.
export default {
  async fetch() {
    return new Response('phase3-tests probe worker', { status: 200 });
  },
};
