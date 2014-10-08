var util = require('util');
var net = require("net"),
	params = require('commander'),
	url = require('url'),
	debug = require('debug')('proxy'),
	http = require('http'),
	https = require('https'),
	fs = require('fs');

params.version('0.0.1')
	.option('-p, --port <n>', 'source port', parseInt)
	.option('-d, --destination <host>', 'destination host to proxy, e.g.: socket://host:port, http://host, http://host:non80port, https://host:non443port')
	.option('-k, --key [key]', 'key certificate for https')
	.option('-c, --cert [cert]', 'certificate for https')
	.option('-u, --rejectUnauthorized', 'reject unaothorized')
	.parse(process.argv);

if(!params.port || !params.destination) {
	return params.help();
}

params.url = url.parse(params.destination, true);
debug('url: %o', params.url);

if(!params.url.protocol || ['socket:', 'http:', 'https:'].indexOf(params.url.protocol) === -1) {
	console.error('Unknown protocol '+ params.url.protocol);
	return params.help();
}

if(params.url.protocol === 'https:') {
	if(!params.cert) {
		console.error('cert is missing');
		return params.help();
	}

	if(!params.key) {
		console.error('key is missing');
		return params.help();
	}
}


process.on("uncaughtException", function(e) {
    console.error(e);
});

net.createServer(function (proxySocket) {
	console.info('proxy to '+params.destination+' from port '+params.port);
	if(params.url.protocol === 'socket:') {
		debug('socket connection');
		proxyToSocket(proxySocket);
	} else if (params.url.protocol === 'http:') {
		debug('http connection');
		proxyToHttp(proxySocket);
	} else if (params.url.protocol === 'https:') {
		debug('secure https connection');
		proxyToHttp(proxySocket, params);
	} else {
		console.error('not yet supported');
		process.exit(1);
	}
}).listen(params.port);

function proxyToSocket(proxySocket) {
	var connected = false;
	var buffers = new Array();
	var serviceSocket = new net.Socket();
	serviceSocket.connect(parseInt(params.url.port), params.url.hostname, function() {
		connected = true;
		if (buffers.length == 0) {
			return;
		}
		for (i = 0; i < buffers.length; i++) {
			console.log(buffers[i]);
			serviceSocket.write(buffers[i]);
			debug('buffer %d: %o', i, buffers[i])
		}
	});
	
	proxySocket.on("error", function (e) {
		console.log('error:'+e);
		serviceSocket.end();
	});
	serviceSocket.on("error", function (e) {
		console.log("Could not connect to service at host "
			+ params.url.hostname + ', port ' + params.url.port+':'+e);
		proxySocket.end();
	});
	
	proxySocket.on("data", function (data) {
	debug('data: %o', data);
	if (connected) {
		serviceSocket.write(data);
	} else {
		buffers[buffers.length] = data;
	}
	});
	serviceSocket.on("data", function(data) {
		proxySocket.write(data);
	});
	proxySocket.on("close", function(had_error) {
		serviceSocket.end();
	});
	serviceSocket.on("close", function(had_error) {
		proxySocket.end();
	});
}

function sendJson(res, body, cookies){
	debug('send header before: %o or %o', res.headers, res._headers);
	res.setHeader('Content-Type', 'application/json')
	if(cookies) {
		var cookie = '';
		for(var key in cookies) {
			cookie += (cookie ? ';' : '') +key + '='+cookies[key].value;
		}
		debug('setting cookie: %o', cookie);
		res.setHeader('Cookie', cookie);
	}
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('accept', 'application/json');
	res.write(JSON.stringify(body));
	res.end();
}

function proxyToHttp(proxySocket, httpsOptions) {
	var connected = false,
		queue = [],
		processing = false,
		options = {
			hostname: params.url.hostname,
			port: 	params.url.port,
			path: params.url.path || '/',
			method: 'POST'
		},
		httpOrHttps = http,
		cookies = {},
		buffers = [],
		refreshTimer,
		numberofEmptyResponses = 0,
		refreshTimerIfRequired = function() {
			if (numberofEmptyResponses > 10) {
				if (refreshTimer) {
					debug('remove interval because of exceed number of empty responses');
					clearInterval(refreshTimer);
					refreshTimer = null;
				}
			} else {
				if (!refreshTimer) {
					refreshTimer = setInterval(function() {
						if(processing) {
							debug('processing %o', processing);
							return;
						}
						++numberofEmptyResponses;
						debug('sending refresh request %o', numberofEmptyResponses);
						sendReq({cmd:'check'});
					}, 200, true)
				}
			}
		},
		startConnection = function(){
			sendReq({cmd:'connect'});
			refreshTimerIfRequired();
			proxySocket.on("error", function (e) {
				console.error('error:'+e);
			});
			
			proxySocket.on("data", function (data) {
				debug('data: %o', data);
				sendReq({data:data});
			});
			proxySocket.on("close", function(had_error) {
				debug('closing connection %o', had_error);
				sendReq({cmd:'close'});
			});
		},
		endConnection = function() {
			if(refreshTimer) {
				clearInterval(refreshTimer);
			}
			proxySocket.end();
		},
		sendReq = function(data){
			debug('send data %o', data);
			if(!data.cmd || data.cmd !== 'check') {
				queue.push(data);
			}
			
			if(processing) {
				debug('will process later');
				return;
			}
			
			processing = true;
			
			var req = httpOrHttps.request(options, function(res){
						debug('STATUS: %o', res.statusCode);
						//debug('HEADERS: %o', res.headers);
						if(res.statusCode !== 200) {
							console.error('error from server with status '+res.statusCode);
							endConnection();
							return;
						}
						if(res.headers['set-cookie']) {
							var cookiesRepl = res.headers['set-cookie'];
							for(var i = 0; i < cookiesRepl.length; ++i) {
								var row = cookiesRepl[i],
									keyIndex = row.indexOf('='),
									key = row.substring(0, keyIndex),
									valueIndex = row.indexOf(';', keyIndex),
									value = row.substring(keyIndex+1, valueIndex);
									cookies[key] = {
										value: value,
										raw: row
									};
							}
							debug('updaed cookies %o', cookies);
						}
						res.setEncoding('utf8');
						var responseStr = '';
						res.on('data', function (chunk) {
							//debug('BODY: %o', chunk);
							responseStr += chunk;
						});
						res.on('end', function() {
							processing = false;
							debug('http req end with body %o', responseStr);
							var responseObj = JSON.parse(responseStr),
								isEmptyResponse = false;
							
							debug('receiving %o', responseObj);
							if(responseObj.cmd) {
								if(responseObj.cmd === 'close') {
									debug('receiving to close connection');
									return endConnection();
								} else {
									throw "Uknown command "+ responseObj.cmd;
								}
							} else if (responseObj.data) {
								numberofEmptyResponses = 0;
								for(var i = 0; i < responseObj.data.length; ++i) {
									proxySocket.write(new Buffer(responseObj.data[i], 'base64'));
								}
							} else {
								isEmptyResponse = true;
							}
							
							if(queue.length) {
								debug('check queue');
								sendReq({cmd:'check'});
							} else if (!isEmptyResponse) {
								// Send 1 more request because may exists more data
								setTimeout(function() {
									sendReq({cmd:'check'});
								}, 50)
							} else {
								refreshTimerIfRequired();
							}
						})
					});
					
			req.on('error', function(e) {
				processing = false;
				console.log('problem with request: ' + e.message);
				proxySocket.end();
			});
			var body = {
				type: 'ssh'
				};
			if(queue.length) {
				numberofEmptyResponses = 0;
				debug('processing queue %o', queue);
				body.data = [];
				body.iter = 0;
				for (var i = 0; i < queue.length; ++i) {
					var currCmd = queue[i];
					
					if(currCmd.cmd) {
						body.cmd = currCmd.cmd;
						break;
					}
					
					body.data.push(currCmd.data.toString('base64'));
					++body.iter;
				}
				
				if(!body.data && !body.cmd) {
					body.cmd = 'close';
				}
				queue = [];
			} else {
				body.cmd = 'check';
			}
			
			debug('sending body %', body);
			sendJson(req, body, cookies)
			//req.json(body);
			//req.write(JSON.stringify(body));
			//req.end();
		};
	
	if(httpsOptions) {
		debug('secure connection %o', httpsOptions);

		options.key = fs.readFileSync(httpsOptions.key);
		options.cert = fs.readFileSync(httpsOptions.cert);
		options.gent = new https.Agent(options);
		if(typeof(httpsOptions.rejectUnauthorized) === 'boolean') {
			debug('rejectUnauthorized: %o', true)
			options.rejectUnauthorized = true;
		} else {
			options.rejectUnauthorized = false;
		}
		options.passphrase = 'Nu4eu1ta';
		httpOrHttps = https;
	}
	
	debug();

	startConnection();
}