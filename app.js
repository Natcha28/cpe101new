/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */

(function () {
    "use strict";

    // Override the node module path to disallow loading packages (via require)
    // that are outside of the generator and plugin folders.
    global.whitelistedModuleFolders = [__dirname];
    var Module = require("module").Module;
    var nodeModulePaths = Module._nodeModulePaths.bind(Module);
    Module._nodeModulePaths = function (from) {
        return nodeModulePaths(from).filter(function (path) {
            for (var i = 0; i < global.whitelistedModuleFolders.length; i++) {
                var p = global.whitelistedModuleFolders[i];
                if (path.substring(0, p.length) === p) {
                    return path;
                }
            }
        });
    };

    var fs = require("fs"),
        resolve = require("path").resolve,
        util = require("util"),
        optimist = require("optimist"),
        Q = require("q"),
        config = require("./lib/config").getConfig(),
        generator = require("./lib/generator"),
        stdlog = require("./lib/stdlog"),
        logging = require("./lib/logging"),
        utils = require("./lib/utils");

    var PLUGIN_KEY_PREFIX = "PLUGIN-";

    var _loggerManager = new logging.LoggerManager(logging.LOG_LEVEL_INFO),
        _logStream = new logging.StreamFormatter(_loggerManager),
        _logger = _loggerManager.createLogger("app");

    // For backwards compatibility, set the logStream on the generator object
    // even though I believe the only place this was previously referenced was in this file
    generator.logStream = _logStream;

    // On Windows, the bullet character is sometimes replaced with the bell character BEL (0x07).
    // This causes Windows to make a beeping noise every time ??? is printed to the console.
    // Use ?? instead. This needs to happen before adding stdlog to not affect the log files.
    if (process.platform === "win32") {
        utils.filterWriteStream(process.stdout, utils.replaceBullet);
        utils.filterWriteStream(process.stderr, utils.replaceBullet);
    }

    var optionParser = optimist["default"]({
        "p" : 49494,
        "h" : "127.0.0.1",
        "P" : "password",
        "i" : null,
        "o" : null,
        "f" : null,
        "photoshopVersion": null,
        "photoshopPath": null,
        "photoshopBinaryPath": null,
        "photoshopLogPath": null,
        "whiteListedPlugins": null
    });

    var argv = optionParser
        .usage("Run generator service.\nUsage: $0")
        .describe({
            "p": "Photoshop server port",
            "h": "Photoshop server host",
            "P": "Photoshop server password",
            "i": "file descriptor of input pipe",
            "o": "file descriptor of output pipe",
            "f": "folder to search for plugins (can be used multiple times)",
            "v": "include verbose generator logging in stdout",
            "photoshopVersion": "tell Generator PS's version so it isn't queried at startup (optional)",
            "photoshopPath": "tell Generator PS's path so it isn't queried at startup (optional)",
            "photoshopBinaryPath": "tell Generator PS's binary location so it isn't queried at startup (optional)",
            "photoshopLogPath": "log root directory, required for generator built in mode",
            "whiteListedPlugins": "A comma seperated list of plugin names that are ok to run (optional)",
            "help": "display help message"
        }).alias({
            "p": "port",
            "h": "host",
            "P": "password",
            "i": "input",
            "o": "output",
            "f": "pluginfolder",
            "v": "verbose"
        }).string("photoshopVersion")
        .argv;

    if (argv.help) {
        console.log(optimist.help());
        process.exit(0);
    }

    // Warn when photoshopLogPath not supplied.
    // This is probably OK, and only applicable to "remote" generator development
    if (!argv.photoshopLogPath) {
        console.log(
            "Generator did not receive a log location via 'photoshopLogPath' param; may use a non-standard location");
    }

    var logSettings = {
        vendor:      "Adobe",
        application: "Adobe Photoshop Generator", // for fall-back log location when photoshopLogPath not given
        logRoot:     argv.photoshopLogPath,
        module:      "Generator",
        verbose:     argv.verbose
    };

    // Initialize log file writer
    // This will tap stdout and read generator-logger's readable stream
    stdlog.setup(logSettings, _logStream);

    function stop(exitCode, reason) {
        if (!reason) {
            reason = "no reason given";
        }
        _logger.error("Exiting with code " + exitCode + ": " + reason);
        process.exit(exitCode);
    }

    function scanPluginDirectories(folders, theGenerator) {
        var allPlugins = [];

        function listPluginsInDirectory(directory) {

            function verifyPluginAtPath(absolutePath) {
                var result = null,
                    metadata = null,
                    compatibility = null;

                try {
                    metadata = theGenerator.getPluginMetadata(absolutePath);
                    compatibility = theGenerator.checkPluginCompatibility(metadata);
                    if (compatibility.compatible) {
                        result = {
                            path: absolutePath,
                            metadata: metadata
                        };
                    }

                    if (compatibility.message) {
                        _logger.warn("Potential problem with plugin at '" + absolutePath +
                            "': " + compatibility.message);
                    }
                } catch (metadataLoadError) {
                    // Do nothing
                }
                return result;
            }

            function checkIfPathDirectory(absolutePath) {
                var result = false;
                try {
                    result = fs.statSync(absolutePath).isDirectory();
                } catch (err) {
                    _logger.error(err);
                }
                return result;
            }

            // relative paths are resolved relative to the current working directory
            var absolutePath = resolve(process.cwd(), directory),
                plugins = [],
                potentialPlugin = null;

            if (!checkIfPathDirectory(absolutePath)) {
                _logger.error("Error: specified plugin path '%s' is not a directory", absolutePath);
                return plugins;
            }

            // First, try treating the directory as a plugin

            potentialPlugin = verifyPluginAtPath(absolutePath);
            if (potentialPlugin) {
                plugins.push(potentialPlugin);
            }

            // If we didn't find a compatible plugin at the root level,
            // then scan one level deep for plugins
            if (plugins.length === 0) {
                fs.readdirSync(absolutePath)
                    .map(function (child) {
                        return resolve(absolutePath, child);
                    })
                    .filter(function (absoluteChildPath) {
                        return checkIfPathDirectory(absoluteChildPath);
                    })
                    .forEach(function (absolutePluginPath) {
                        potentialPlugin = verifyPluginAtPath(absolutePluginPath);
                        if (potentialPlugin) {
                            plugins.push(potentialPlugin);
                        }
                    });
            }

            return plugins;
        }

        if (!util.isArray(folders)) {
            folders = [folders];
        }

        folders.forEach(function (f) {
            global.whitelistedModuleFolders.push(f);
            try {
                var currentPluginCount = allPlugins.length;
                allPlugins = allPlugins.concat(listPluginsInDirectory(f));
                if (currentPluginCount === allPlugins.length) {
                    // No plugins found in this directory
                    _logger.warn("No viable plugins were found in '" + f + "'");
                }
            } catch (e) {
                _logger.error("Error processing plugin directory %s\n", f, e);
            }
        });

        return allPlugins;
    }

    function setupGenerator() {
        var deferred = Q.defer();
        var theGenerator = generator.createGenerator(_loggerManager);

        // NOTE: It *should* be the case that node automatically cleans up all pipes/sockets
        // on exit. However, on node v0.10.15 mac 64-bit there seems to be a bug where
        // the native-side process exit hangs if node is blocked on the read of a pipe.
        // This meant that if Generator had an unhandled exception after starting to read
        // from PS's pipe, the node process wouldn't fully exit until PS closed the pipe.
        process.on("exit", function () {
            if (theGenerator) {
                theGenerator.shutdown();
            }
        });

        theGenerator.on("close", function () {
            setTimeout(function () {
                stop(0, "Generator close event");
            }, 1000);
        });

        var options = {};
        if ((typeof argv.input === "number" && typeof argv.output === "number") ||
            (typeof argv.input === "string" && typeof argv.output === "string")) {
            options.inputFd = argv.input;
            options.outputFd = argv.output;
            options.password = null; // No encryption over pipes
        } else if (typeof argv.port === "number" && argv.host && argv.password) {
            options.port = argv.port;
            options.hostname = argv.host;
            options.password = argv.password;
        }

        if (argv.photoshopVersion && typeof argv.photoshopVersion === "string") {
            options.photoshopVersion = argv.photoshopVersion;
        }
        if (argv.photoshopPath && typeof argv.photoshopPath === "string") {
            options.photoshopPath = argv.photoshopPath;
        }
        if (argv.photoshopBinaryPath && typeof argv.photoshopBinaryPath === "string") {
            options.photoshopBinaryPath = argv.photoshopBinaryPath;
        }

        options.config = config;

        theGenerator.start(options).done(
            function () {
                var semver = require("semver"),
                    totalPluginCount = 0,
                    pluginMap = {},
                    plugins = scanPluginDirectories(argv.pluginfolder, theGenerator),
                    shouldWhiteList = typeof argv.whiteListedPlugins === "string",
                    whiteListedPlugins;

                if (shouldWhiteList) {
                    whiteListedPlugins = argv.whiteListedPlugins.split(",").map(function (s) { return s.trim(); });
                }


                // Ensure all plugins have a valid semver, then put them in to a map
                // keyed on plugin name

                plugins.forEach(function (p) {
                    if (shouldWhiteList && whiteListedPlugins.indexOf(p.metadata.name) === -1) {
                        //if we are in "whitelist mode" skip any plugins that are not in the array
                        return;
                    }
                    if (!semver.valid(p.metadata.version)) {
                        p.metadata.version = "0.0.0";
                    }
                    if (!pluginMap[PLUGIN_KEY_PREFIX + p.metadata.name]) {
                        pluginMap[PLUGIN_KEY_PREFIX + p.metadata.name] = [];
                    }
                    pluginMap[PLUGIN_KEY_PREFIX + p.metadata.name].push(p);
                });

                // For each unique plugin name, try to load a plugin with that name
                // in decending order of version
                Object.keys(pluginMap).forEach(function (pluginSetKey) {
                    var pluginSet = pluginMap[pluginSetKey],
                        i,
                        loaded = false;

                    pluginSet.sort(function (a, b) {
                        return semver.rcompare(a.metadata.version, b.metadata.version);
                    });

                    for (i = 0; i < pluginSet.length; i++) {
                        try {
                            theGenerator.loadPlugin(pluginSet[i].path);
                            loaded = true;
                        } catch (loadingException) {
                            _logger.error("Unable to load plugin at '" + pluginSet[i].path + "': " +
                                loadingException.message);
                        }

                        if (loaded) {
                            totalPluginCount++;
                            break;
                        }
                    }

                });


                if (totalPluginCount === 0) {
                    // Without any plugins, Generator will never do anything. So, we exit.
                    deferred.reject("Generator requires at least one plugin to function, zero were loaded.");
                } else {
                    deferred.resolve(theGenerator);
                }
            },
            function (err) {
                deferred.reject(err);
            }
        );

        return deferred.promise;
    }

    function init() {
        // Start async process to initialize generator
        setupGenerator().fail(
            function (err) {
                stop(-3, "Generator failed to initialize: " + err);
            });
    }

    process.on("uncaughtException", function (err) {
        if (err) {
            if (err.stack) {
                _logger.error(err.stack);
            } else {
                _logger.error(err);
            }
        }

        stop(-1, "Uncaught exception" + (err ? (": " + err.message) : "undefined"));
    });

    init();

}());
