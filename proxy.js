var util = require('util');
var net = require("net"),
	params = require('commander'),
	url = require('url'),
	debug = require('debug')('proxy'),
	http = require('http'),
	https = require('https');

params.version('0.0.1')
	.option('-p, --port <n>', 'source port', parseInt)
	.option('-d, --destination <host>', 'destination host to proxy, e.g.: socket://host:port, http://host, http://host:non80port, https://host:non443port')
	.option('-c --cert <cert>', 'certificate')
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

process.on("uncaughtException", function(e) {
    console.error(e);
});
 
net.createServer(function (proxySocket) {
	console.info('proxy to '+params.destination+' from port '+params.port);
	if(params.url.protocol === 'socket:') {
		proxyToSocket(proxySocket);
	} else if (params.url.protocol === 'http:') {
		proxyToHttp(proxySocket);
	} else if (params.url.protocol === 'https:') {
		proxyToHttps(proxySocket);
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

function proxyToHttp(proxySocket) {
	var connected = false,
		queue = [],
		processing = false,
		options = {
			hostname: params.url.hostname,
			port: 	params.url.port,
			path: params.url.path || '/',
			method: 'POST'
		},
		cookies = {},
		buffers = [],
		refreshTimer,
		startConnection = function(){
			sendReq({cmd:'connect'});
			/*refreshTimer = setInterval(function() {
				if(processing) {
					return;
				}
				debug('sending refresh request');
				sendReq({cmd:'check'});
			}, 500, true)*/
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
			
			var req = http.request(options, function(res){
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
								// Send 1 more request because may exists the case when
								setTimeout(function() {
									sendReq({cmd:'check'});
								}, 700)
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
	
	startConnection();
}

function proxyToHttps(proxySocket) {
	var connected = false;
	var buffers = new Array();
}
