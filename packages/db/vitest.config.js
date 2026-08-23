export default {
  test: {
    // Integration tests share one database; running files in parallel would have them
    // truncating each other's rows mid-assertion.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000
  }
}
