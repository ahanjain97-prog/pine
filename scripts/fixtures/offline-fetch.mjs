// Used only by the isolated HTTP smoke test and visual preview server.
// Prevent startup housekeeping from reaching providers or reading private remote data.
globalThis.fetch = async () => { throw new Error('Provider access disabled in local preview'); };
