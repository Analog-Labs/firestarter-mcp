/**
 * Test setup for the standalone MCP server package.
 *
 * The stdio entrypoint exits at import time without an API key, so tests that
 * import it need a placeholder. No network call is ever made with it — every
 * test stubs global fetch.
 */
process.env.FIRESTARTER_API_KEY ||= "fs_test_placeholder";
