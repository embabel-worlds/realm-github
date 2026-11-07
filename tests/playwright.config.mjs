/* The page harness only; verify.sh beside it reconciles the views against GitHub by hand. */
export default { testDir: ".", testMatch: /.*\.spec\.mjs$/, timeout: 20000, use: { headless: true } };
