/* eslint-env jest */
const path = require('path');

describe('server.js', () => {
  const originalPort = process.env.PORT;
  let consoleLogSpy;

  afterEach(() => {
    // restore environment and spies
    process.env.PORT = originalPort;
    if (consoleLogSpy && consoleLogSpy.mockRestore) consoleLogSpy.mockRestore();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('uses process.env.PORT when set and calls app.listen with that port', () => {
    jest.resetModules();

    // ensure env var is set before the module is loaded
    process.env.PORT = '1234';

    // mock out ./lib/loadEnv so it doesn't attempt to read files or mutate env
    jest.doMock(path.join(__dirname, '..', 'lib', 'loadEnv'), () => ({}));

    // prepare a mock for app.listen that will invoke the callback immediately
    const mockListen = jest.fn((port, cb) => {
      if (typeof cb === 'function') cb();
      return {};
    });

    jest.doMock(path.join(__dirname, '..', 'app'), () => ({ listen: mockListen }));

    // spy on console.log to capture the startup message
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // require server (this will run the script)
    jest.isolateModules(() => {
      require(path.join(__dirname, '..', 'server.js'));
    });

    expect(mockListen).toHaveBeenCalledTimes(1);
    // first argument passed to listen should be the env PORT string
    expect(mockListen.mock.calls[0][0]).toBe('1234');
    expect(consoleLogSpy).toHaveBeenCalledWith('Server listening on port 1234');
  });

  test('defaults to port 8080 when process.env.PORT is not set', () => {
    jest.resetModules();

    // make sure PORT is undefined for this test
    delete process.env.PORT;

    jest.doMock(path.join(__dirname, '..', 'lib', 'loadEnv'), () => ({}));

    const mockListen = jest.fn((port, cb) => {
      if (typeof cb === 'function') cb();
      return {};
    });

    jest.doMock(path.join(__dirname, '..', 'app'), () => ({ listen: mockListen }));

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.isolateModules(() => {
      require(path.join(__dirname, '..', 'server.js'));
    });

    expect(mockListen).toHaveBeenCalledTimes(1);
    // server.js sets const port = process.env.PORT || 8080 => numeric 8080
    expect(mockListen.mock.calls[0][0]).toBe(8080);
    expect(consoleLogSpy).toHaveBeenCalledWith('Server listening on port 8080');
  });
});
