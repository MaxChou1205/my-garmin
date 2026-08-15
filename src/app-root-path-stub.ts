/**
 * ponytail: app-root-path exists in this dependency tree for exactly one reason —
 * GarminConnect.js does `appRoot.require('/garmin.config.json')` at module load to
 * pick up an optional config file. There is no project root on workerd, and the
 * package's browser shim crashes reading `require.main.filename` before our code
 * ever runs. Throwing is the correct behaviour: the caller already wraps it in
 * try/catch and falls back to `config = undefined`, which is what we want since we
 * pass credentials to the constructor instead.
 */
export default {
    require(): never {
        throw new Error('app-root-path: no filesystem project root on workerd');
    },
};
