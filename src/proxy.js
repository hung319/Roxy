import { handleRequest } from '../utils/handler'; // Giả định bạn có hàm này

function processM3U8Content(content, mediaUrl, origin, headers) {
	const hasHeaders = headers && Object.keys(headers).length > 0;
	const _headers = hasHeaders ? `&headers=${encodeURIComponent(btoa(JSON.stringify(headers)))}` : '';
	return content
		.split('\n')
		.map((line) => {
			const uriMatch = line.match(/(URI=)(["'])(?<uri>.*?)\2/);
			if (uriMatch) {
				const [fullMatch, prefix, quote] = uriMatch;
				try {
					const resolvedUrl = new URL(uriMatch.groups.uri, mediaUrl).toString();
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}${_headers}`;
					return line.replace(fullMatch, `${prefix}${quote}${proxyUrl}${quote}`);
				} catch (error) {
					console.error('Error processing URI in M3U8:', uriMatch.groups.uri, error);
					return line;
				}
			}

			if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF') || line.startsWith('#EXT-X-MEDIA:') ) {
				return line;
			}

			if (!line.startsWith('#') && line.trim()) {
				try {
					const resolvedUrl = new URL(line.trim(), mediaUrl).toString();
					// Đã loại bỏ &segmentRole=media
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}${_headers}`;
					return proxyUrl;
				} catch (error) {
					console.error('Error processing segment URL in M3U8:', line.trim(), error);
					return line;
				}
			}

			return line;
		})
		.join('\n');
}

async function proxy(request) {
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, X-Custom-Header',
				'Access-Control-Max-Age': '86400',
			},
		});
	}

	try {
		const requestUrlObject = new URL(request.url);
		const mediaUrlFromQuery = requestUrlObject.searchParams.get('url');
		const headersFromQueryParam = requestUrlObject.searchParams.get('headers');
		// const segmentRole = requestUrlObject.searchParams.get('segmentRole'); // Đã loại bỏ
		const origin = `${requestUrlObject.protocol}//${requestUrlObject.host}`;

		if (!mediaUrlFromQuery) {
			return new Response('Missing url parameter', { 
				status: 400, 
				headers: { 'Access-Control-Allow-Origin': '*' } 
			});
		}
		
		let mediaUrl = decodeURIComponent(mediaUrlFromQuery);

		let decodedHeadersFromM3U8 = {};
		if (headersFromQueryParam) {
			try {
				decodedHeadersFromM3U8 = JSON.parse(atob(decodeURIComponent(headersFromQueryParam)));
			} catch (e) {
				console.error('Failed to parse headers from M3U8 query param:', e);
			}
		}
		
		const clientRequestHeaders = {};
		if (request.headers.get('Range')) {
			clientRequestHeaders['Range'] = request.headers.get('Range');
		}

		const fetchHeaders = {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/237.84.2.178 Safari/537.36',
			Connection: 'keep-alive',
			...decodedHeadersFromM3U8,
			...clientRequestHeaders,
		};

		const originResponse = await fetch(mediaUrl, {
			headers: fetchHeaders,
			redirect: 'follow',
		});

		if (!originResponse.ok) {
			const errorBody = await originResponse.text().catch(() => "Could not read error body");
			console.error(`HTTP error! status: ${originResponse.status} for ${mediaUrl}. Body: ${errorBody}`);
			return new Response(`Upstream server error: ${originResponse.status}. ${errorBody}`, {
				status: originResponse.status > 399 && originResponse.status < 600 ? originResponse.status : 500,
				headers: { 
					'Access-Control-Allow-Origin': '*',
					'Content-Type': originResponse.headers.get('Content-Type') || 'text/plain',
				 },
			});
		}

		const cleanHeaders = Object.fromEntries(
			Array.from(originResponse.headers.entries()).filter(([key], i, arr) => {
				const lowerKey = key.toLowerCase();
				if (lowerKey === 'access-control-allow-origin' || 
					lowerKey === 'access-control-allow-credentials' ||
					lowerKey === 'access-control-expose-headers' ||
					lowerKey === 'access-control-max-age' ||
					lowerKey === 'access-control-allow-methods' ||
					lowerKey === 'access-control-allow-headers' ||
					lowerKey === 'connection' ||
					lowerKey === 'transfer-encoding' ||
					lowerKey.startsWith('cf-') ||
					lowerKey.startsWith('x-amz-')
				) {
					return false;
				}
				return arr.findIndex(([k]) => k.toLowerCase() === lowerKey) === i;
			})
		);

		const clientResponseHeaders = {
			...cleanHeaders,
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Expose-Headers': Object.keys(cleanHeaders).join(', '),
		};

		const originalContentType = (originResponse.headers.get('Content-Type') || '').toLowerCase();
		let shouldForceVideoMp2t = false;

		if (mediaUrl.toLowerCase().endsWith('.ts')) {
			shouldForceVideoMp2t = true;
		} else if (originalContentType === 'video/mp2t') {
			shouldForceVideoMp2t = true;
		}
		// Đã loại bỏ điều kiện "else if (segmentRole === 'media' ...)"

		if (shouldForceVideoMp2t) {
			clientResponseHeaders['Content-Type'] = 'video/mp2t';
		}
		
		let finalIsM3U8 = false;
		let responseBodyAsText;

		const urlSuggestsM3U8 = mediaUrl.toLowerCase().endsWith('.m3u8') || mediaUrl.toLowerCase().includes('/playlist');
		const isM3U8ByOriginalContentType = originalContentType.includes('application/vnd.apple.mpegurl') ||
									originalContentType.includes('application/x-mpegurl') ||
									originalContentType.includes('audio/mpegurl') ||
									originalContentType.includes('audio/x-mpegurl');

		if (!shouldForceVideoMp2t && (urlSuggestsM3U8 || isM3U8ByOriginalContentType)) {
			const tempResponseForText = originResponse.clone();
			try {
			    responseBodyAsText = await tempResponseForText.text();
			    if (responseBodyAsText.trimStart().startsWith('#EXTM3U')) {
				    finalIsM3U8 = true;
			    } else if (isM3U8ByOriginalContentType) {
				    finalIsM3U8 = false;
				    console.warn(`URL: ${mediaUrl} - Content-Type (${originalContentType}) suggested M3U8, but content did not start with #EXTM3U.`);
			    }
            } catch (e) {
                console.warn(`URL: ${mediaUrl} - Error reading text for M3U8 check (suggested by URL/ContentType). Error: ${e.message}. Treating as non-M3U8.`);
                finalIsM3U8 = false;
            }
		}

		if (finalIsM3U8) {
			const processedM3U8 = processM3U8Content(responseBodyAsText, mediaUrl, origin, decodedHeadersFromM3U8);
			clientResponseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
			return new Response(processedM3U8, {
				status: originResponse.status,
				headers: clientResponseHeaders,
			});
		} else {
			return new Response(originResponse.body, {
				status: originResponse.status,
				statusText: originResponse.statusText,
				headers: clientResponseHeaders,
			});
		}

	} catch (error) {
		console.error('Critical error in proxy:', error.message, error.stack);
		return new Response(`Proxy critical error: ${error.message}`, {
			status: 500,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'text/plain',
			},
		});
	}
}

export default proxy;
