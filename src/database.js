class Database {

    static openDatabase(dbLocation) {
        const dbName = dbLocation.split("/").slice(-1)[0]; // Get the DB file basename
        const source = this;
        const isBrowser = !window.device || device.platform === 'browser';
        if ('sqlitePlugin' in self || isBrowser) {
            if('device' in self || isBrowser) {
                return new Promise(function (resolve, reject) {
                    if (isBrowser) {
                        const getRootFile = () => {
                            // window.initPersistentFileSystem(1000*1024*1024 /*1 GB*/, function() {
                            window.requestFileSystem  = window.requestFileSystem || window.webkitRequestFileSystem;
                            window.requestFileSystem(window.PERSISTENT, 1000*1024*1024 /*1 GB*/, function(fs) {
                                resolve(fs.root);
                            }, function(err) {
                                console.error('err', err);
                                reject(err);
                            });
                            // }, function(err) {
                            //     console.error('Could not get permission to use local file storage', err);
                            // });
                        };

                        if (!window.device) {
                          setTimeout(() => {
                            getRootFile();
                          }, 2000);
                        } else {
                          if (window.isFilePluginReadyRaised) {
                              console.log('File plugin is already ready');
                              getRootFile();
                          } else {
                              window.addEventListener('filePluginIsReady', () => {
                                  console.log('File plugin is ready');
                                  getRootFile();
                              }, false);
                          }
                        }

                    } else if(device.platform === 'Android') {
                        resolveLocalFileSystemURL(cordova.file.applicationStorageDirectory, function (dir) {
                            dir.getDirectory('databases', {create: true}, function (subdir) {
                                resolve(subdir);
                            });
                        }, reject);
                    } else if(device.platform === 'iOS') {
                        resolveLocalFileSystemURL(cordova.file.documentsDirectory, resolve, reject);
                    } else {
                        reject("Platform not supported");
                    }
                }).then(function (targetDir) {
                    return new Promise(function (resolve, reject) {
                        targetDir.getFile(dbName, {}, resolve, reject);
                    }).catch(function () {
                        return source.copyDatabaseFile(dbLocation, dbName, targetDir)
                    });
                }).then(function (dbFileEntry) {
                    if (isBrowser) {
                      return window.initSqlJs().then(function(SQL) {
                        return new Promise(function(resolve) {
                          try {
                            dbFileEntry.file(function(file) {
                              const fileReader = new FileReader();
                              fileReader.onloadend = function() {
                                resolve(new SQL.Database(new Uint8Array(this.result)));
                              }
                              fileReader.readAsArrayBuffer(file);
                            });
                          } catch (err) {
                            console.error('Error trying to read dbFile', err);
                          }
                        });
                      }, function(err) {
                        console.error('Error calling initSqlJs', err);
                      });
                    }

                    var params = {name: dbName};
                    if(device.platform === 'iOS') {
                        params.iosDatabaseLocation = 'Documents';
                    } else {
                        params.location = 'default';
                    }
                    return sqlitePlugin.openDatabase(params);
                });
            } else {
                return Promise.reject(new Error("cordova-plugin-device not available. " +
                    "Please install the plugin and make sure this code is run after onDeviceReady event"));
            }
        } else {
            return Promise.reject(new Error("cordova-sqlite-ext plugin not available. " +
                "Please install the plugin and make sure this code is run after onDeviceReady event"));
        }
    }

    static copyDatabaseFile(dbLocation, dbName, targetDir) {
        console.log("Copying database to application storage directory");

        if (!window.device || device.platform === 'browser') {
          return new Promise(function(resolve, reject) {
            // Give instructions to user to select a database file.

            // Create a file input so the developer can select the mbtiles file.
            // We have to allow the developer to select the file because the browser does not allow us to access the users file system.
            // This only shows up for the "browser" platform, which is used for development, so iOS and Android users will never see this.
            const input = document.createElement('input');
            input.setAttribute('type', 'file');
            input.style.position = 'absolute';
            input.style.top = '50%';
            input.style.left = '50%';
            input.style.marginLeft = '-119px';
            document.body.append(input);
            input.onchange = function() {
              const file = this.files[0];
              // Copy the file to the target directory
              targetDir.getFile(dbName, {create: true, exclusive: true}, function(newFile) {
                newFile.createWriter(function(fileWriter) {
                  fileWriter.write(file);
                  resolve(newFile);
                  input.style.display = 'none';
                });
              });
            };

            // Give instructions to user to select a database file.
            alert('Select the database file');
          });
        }

        return new Promise(function (resolve, reject) {
            const absPath =  cordova.file.applicationDirectory + 'www/' + dbLocation;
            resolveLocalFileSystemURL(absPath, resolve, reject);
        }).then(function (sourceFile) {
            return new Promise(function (resolve, reject) {
                sourceFile.copyTo(targetDir, dbName, resolve, reject);
            }).then(function () {
                console.log("Database copied");
            });
        });
    }
}

export default Database
