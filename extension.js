/*

to do:

volume control
low pass filter

beats should be 1-indexed?
reporter for number of beats?
play music like %n and loop?

song stepper example
remix example

*/

(function(ext) {

    if (typeof Tone !== 'undefined') {
        console.log('Tone library is already loaded');
        startExtension();
    } else {
        $.getScript('https://rawgit.com/Tonejs/CDN/gh-pages/r7/Tone.min.js', startExtension);
    }

    function startExtension() {

        var player = new Tone.Player().toMaster();

        var beatPlayer = new Tone.Player();
        var releaseDur = 0.1;
        var ampEnv = new Tone.AmplitudeEnvelope({
            "attack": 0.05,
            "decay": 0,
            "sustain": 10,
            "release": releaseDur
        }).toMaster();
        beatPlayer.connect(ampEnv);

        var audioContext = Tone.context;

        var trackTimingData;
        var currentBeatNum = 0;
        var beatFlag = false;
        var barFlag = false;
        var beatTimeouts = [];
        var barTimeouts = [];
        var trackTimeout;

        var trackStartTime;

        var currentTrackDuration = 0;
        var trackTempo = 0;
        var currentArtistName = 'none';
        var currentTrackName = 'none';
        var currentAlbumName = 'none';
        var numBeats = 0;

        // Cleanup function when the extension is unloaded
        ext._shutdown = function() {};

        // Status reporting code
        // Use this to report missing hardware, plugin or unsupported browser
        ext._getStatus = function() {
            return {status: 2, msg: 'Ready'};
        };

        ext.searchAndPlayAndWait = function(query, callback) {
            requestSearchAndPlay(query, true, callback);
        };

        ext.searchAndPlay = function(query, callback) {
            requestSearchAndPlay(query, false, callback);
        };

        function requestSearchAndPlay(query, waitForTrackToEnd, callback) {

            if (player) {
                player.stop();
            }

            $.ajax({
                url: 'https://api.spotify.com/v1/search',
                data: {
                    q: query,
                    type: 'track'
                },
                success: function (response) {
                    var trackObjects = response['tracks']['items'];

                    // fail if there are no tracks
                    if (!trackObjects) {
                        resetTrackData();
                        callback();
                        return;
                    }

                    // find the first result without explicit lyrics
                    var trackObject;
                    for (var i=0; i<trackObjects.length; i++) {
                        if (!trackObjects[i].explicit) {
                            trackObject = trackObjects[i];
                            break;
                        }
                    }

                    // fail if there were none without explicit lyrics
                    if (!trackObject) {
                        resetTrackData();
                        callback();
                        return;
                    }

                    // store track name, artist, album
                    currentArtistName = trackObject.artists[0].name;
                    currentTrackName = trackObject.name;
                    currentAlbumName = trackObject.album.name;

                    currentBeatNum = 0;

                    // download track, get timing data, and play it

                    var trackURL = trackObject.preview_url;  
                    console.log('trackURL: ' + trackURL);

                    getTrackTimingData(trackURL, trackFinishedLoading);
            
                    function trackFinishedLoading() {
                        if (!waitForTrackToEnd) {
                            callback();
                        } else {
                            trackTimeout = window.setTimeout(function() {
                                callback();
                            }, currentTrackDuration*1000);
                        }
                    }

                },
                error: function() {
                }
            });
        
        };

        function setupTimeouts() {
            // events on each beat
            for (var i=0; i<trackTimingData.beats.length; i++) {
                var t = window.setTimeout(function(i) {
                    beatFlag = true;
                    currentBeatNum = i;
                }, trackTimingData.beats[i] * 1000, i);
                beatTimeouts.push(t);
            }

            // events on each bar
            for (var i=0; i<trackTimingData.downbeats.length; i++) {
                var t = window.setTimeout(function() {
                    barFlag = true;
                }, trackTimingData.downbeats[i] * 1000);
                barTimeouts.push(t);
            }
        }

        function resetTrackData() {
            currentArtistName = 'none';
            currentTrackName = 'none';
            currentAlbumName = 'none';
            trackTempo = 0;
        }              

        // code adapted from spotify
        function getTrackTimingData(url, callback) {

            function findString(buffer, string) {
              for (var i = 0; i < buffer.length - string.length; i++) {
                var match = true;
                for (var j = 0; j < string.length; j++) {
                  var c = String.fromCharCode(buffer[i + j]);
                  if (c !== string[j]) {
                    match = false;
                    break;
                  }
                }
                if (match) {
                  return i;
                }
              }
              return -1;
            }

            function getSection(buffer, start, which) {
              var sectionCount = 0;
              for (var i = start; i < buffer.length; i++) {
                if (buffer[i] == 0) {
                  sectionCount++;
                }
                if (sectionCount >= which) {
                  break;
                }
              }
              i++;
              var content = '';
              while (i < buffer.length) {
                if (buffer[i] == 0) {
                  break;
                }
                var c = String.fromCharCode(buffer[i]);
                content += c;
                i++;
              }
              var js = eval('(' + content + ')');
              return js;
            }

            function makeRequest(url, callback) {
                var request = new XMLHttpRequest();
                request.open('GET', url, true);
                request.responseType = 'arraybuffer';
                request.onload = function() {
                    var buffer = new Uint8Array(this.response); // this.response == uInt8Array.buffer
                    var idx = findString(buffer, 'GEOB');

                    trackTimingData = getSection(buffer, idx + 1, 8);

                    console.log(trackTimingData);

                    // estimate the tempo using the average time interval between beats
                    var sum =0;
                    for (var i=0; i<trackTimingData.beats.length-1; i++) {
                        sum += trackTimingData.beats[i+1] - trackTimingData.beats[i];
                    }
                    var beatLength = sum / (trackTimingData.beats.length - 1);
                    trackTempo = 60 / beatLength;

                    // use the loop duration to set the number of beats

                    for (var i=0; i<trackTimingData.beats.length; i++) {
                        if (trackTimingData.loop_duration < trackTimingData.beats[i]) {
                            numBeats = i;
                            break;
                        }
                    }

                    // decode and play the audio
                    audioContext.decodeAudioData(request.response, function(buffer) {
                        currentTrackDuration = player.buffer.duration;
                        setupTimeouts();
                        player.buffer.set(buffer);
                        player.start(); 
                        trackStartTime = Tone.now();
                        beatPlayer.buffer.set(buffer);
                        // Tone.Transport.start();
                        // player.start('+0', trackTimingData.beats[0]);
                        callback();   
                    }); 
                }
                request.send();
            }

            makeRequest(url, callback);
        }

        ext.trackName = function() {
            return currentTrackName;
        };

        ext.artistName = function() {
            return currentArtistName;
        };

        ext.albumName = function() {
            return currentAlbumName;
        };

        ext.trackTempo = function() {
            return trackTempo;
        };

        ext.playNextBeat = function() {
            setCurrentBeatNum(currentBeatNum + 1);
            playCurrentBeat();    
        };

        ext.playBeat = function(num) {
            setCurrentBeatNum(num);
            playCurrentBeat();
        };

        ext.playBeatAndWait = function(num, callback) {
            setCurrentBeatNum(num);
            playCurrentBeat(callback);
        };

        function setCurrentBeatNum(num) {
            num = Math.round(num);
            currentBeatNum = num % numBeats;
            if (currentBeatNum < 0) {
                currentBeatNum += numBeats;
            }
        }

        function playCurrentBeat(callback) {
            var startTime = trackTimingData.beats[currentBeatNum];
            var duration;
            if ((currentBeatNum + 1) < trackTimingData.beats.length) {
                var endTime = trackTimingData.beats[currentBeatNum+1];
                duration = endTime - startTime;
            } else {
                duration = currentTrackDuration - startTime;
            }

            beatPlayer.stop();
            beatPlayer.start('+0', startTime, duration+releaseDur);
            ampEnv.triggerAttackRelease(duration);

            beatFlag = true;  
            if (callback) {
                window.setTimeout(function() {
                    callback();
                }, duration * 1000);
            } 
        }

        ext.currentBeat = function() {
            return currentBeatNum;
        };

        ext.stopMusic = function() {
            player.stop();
            clearTimeouts();
        };

        function clearTimeouts() {
            clearTimeout(trackTimeout);
            for (var i=0; i<beatTimeouts.length; i++) {
                clearTimeout(beatTimeouts[i]);
            }
            for (var i=0; i<barTimeouts.length; i++) {
                clearTimeout(barTimeouts[i]);
            }
        }

        ext.everyBeat = function() {
            if (beatFlag) {
                // console.log('beat time: ' + trackTimingData.beats[currentBeatNum] + ' ' + 
                //     'measured time: ' + (Tone.now() - trackStartTime) + ' ' +
                //     'diff: ' + ((Tone.now() - trackStartTime) - trackTimingData.beats[currentBeatNum])
                //     );
                window.setTimeout(function() {
                    beatFlag = false;
                }, 10);
                return true;
            }
            return false;
        };

        ext.everyBar = function() {
            if (barFlag) {
                window.setTimeout(function() {
                    barFlag = false;
                }, 10);
                return true;
            }
            return false;
        };

        // Block and block menu descriptions
        var descriptor = {
            blocks: [
              ['w', 'play music like %s', 'searchAndPlay', 'happy'],
              ['w', 'play music like %s and wait', 'searchAndPlayAndWait', 'michael jackson'],
              ['r', 'track name', 'trackName'],
              ['r', 'artist name', 'artistName'],
              ['r', 'album name', 'albumName'],
              ['r', 'track tempo', 'trackTempo'],
              [' ', 'play next beat', 'playNextBeat'],
              ['r', 'current beat', 'currentBeat'],
              [' ', 'play beat %n', 'playBeat', 4],
              ['w', 'play beat %n and wait', 'playBeatAndWait', 4],
              [' ', 'stop the music', 'stopMusic'],
              ['h', 'every beat', 'everyBeat'],
              ['h', 'every bar', 'everyBar']
            ]
        };

        // Register the extension
        ScratchExtensions.register('Spotify', descriptor, ext);
    }

})({});