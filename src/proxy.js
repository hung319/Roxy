import { handleRequest } from '../utils/handler';

function processM3U8Content(content, mediaUrl, origin, headers) {
	const hasHeaders = headers && Object.keys(headers).length > 0;
	const _headers = hasHeaders ? `&headers=${btoa(JSON.stringify(headers))}` : '';
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
					console.error('Error processing URI:', uriMatch.groups.uri, error);
					return line;
				}
			}

			if (line.startsWith('#EXT-X-STREAM-INF')) {
				return line;
			}

			if (!line.startsWith('#') && line.trim()) {
				try {
					const resolvedUrl = new URL(line.trim(), mediaUrl).toString();
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}${_headers}`;
					return proxyUrl;
				} catch (error) {
					console.error('Error processing URL:', line.trim(), error);
					return line;
				}
			}

			return line;
		})
		.join('\n');
}

async function proxy(request) {
	// console.log(`Processing ${request.method} request for: ${request.url}`);
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
				'Access-Control-Max-Age': '86400',
			},
		});
	}

	try {
		let [mediaUrl, decodedHeaders, origin] = handleRequest(request);

		const rangeHeader = request.headers.get('Range');
		const fetchHeaders = {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/237.84.2.178 Safari/537.36',
			Connection: 'keep-alive',
			...decodedHeaders,
		};

		if (rangeHeader) {
			fetchHeaders['Range'] = rangeHeader;
		}

		const response = await fetch(mediaUrl, {
			headers: fetchHeaders,
		});

		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		const cleanHeaders = Object.fromEntries(
			Array.from(response.headers.entries()).filter(([key], i, arr) => arr.findIndex(([k]) => k.toLowerCase() === key.toLowerCase()) === i)
		);
		delete cleanHeaders['Access-Control-Allow-Origin'];
		delete cleanHeaders['access-control-allow-origin'];
		const responseHeaders = {
			...cleanHeaders,
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Expose-Headers': Object.keys(cleanHeaders).join(', '),
		};

		const contentType = response.headers.get('Content-Type') || '';

		// const urlIndication = mediaUrl.toLowerCase().includes('.m3u8') || mediaUrl.toLowerCase().includes('/playlist'); // This variable was unused

		let responseContent = await response.text();
		const contentLooksLikeM3U8 = responseContent.trimStart().startsWith('#EXTM3U');

		const isM3U8 =
			contentLooksLikeM3U8 ||
			contentType.includes('application/vnd.apple.mpegurl') ||
			contentType.includes('application/x-mpegurl') ||
			contentType.includes('audio/mpegurl') ||
			contentType.includes('audio/x-mpegurl');

		if (isM3U8) {
			responseContent = processM3U8Content(responseContent, mediaUrl, origin, decodedHeaders);

			responseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
			return new Response(responseContent, {
				status: response.status,
				headers: responseHeaders,
			});
		}

		// If not M3U8, handle other content (including segments)
		if (!contentLooksLikeM3U8 && responseContent.length > 0) {
			const hasManyNonPrintable =
				responseContent.split('').filter((char) => char.charCodeAt(0) < 32 && char !== '\n' && char !== '\r' && char !== '\t').length >
				responseContent.length * 0.1;

			// This block handles binary content like video/audio segments, images, etc.
			if (
				hasManyNonPrintable ||
				contentType.includes('video/') ||
				contentType.includes('audio/') ||
				contentType.includes('image/') || // Could be image type for segments
				contentType.includes('application/octet-stream')
			) {
				// Re-fetch to get ArrayBuffer for binary manipulation
				const binaryResponse = await fetch(mediaUrl, {
					headers: fetchHeaders,
				});
				let arrayBuffer = await binaryResponse.arrayBuffer();

				// --- MODIFICATION START: Remove 7-byte header from segments ---
				// As per your request, we remove the first 7 bytes from these segments.
				// This assumes that segments processed here might have that prepended header.
				const BYTES_TO_STRIP = 7;
				if (arrayBuffer.byteLength >= BYTES_TO_STRIP) {
					// console.log(`Original segment length for ${mediaUrl}: ${arrayBuffer.byteLength} bytes.`);
					arrayBuffer = arrayBuffer.slice(BYTES_TO_STRIP);
					// console.log(`New segment length after stripping ${BYTES_TO_STRIP} bytes: ${arrayBuffer.byteLength} bytes.`);
				} else {
					// console.log(`Segment ${mediaUrl} is too short (${arrayBuffer.byteLength} bytes) to strip ${BYTES_TO_STRIP} bytes.`);
                                }
				// --- MODIFICATION END ---

				return new Response(arrayBuffer, {
					status: binaryResponse.status,
					headers: responseHeaders,
				});
			}
		}

		// Fallback for other text-based content
		return new Response(responseContent, {
			status: response.status,
			headers: responseHeaders,
		});
	} catch (error) {
		console.error('Error in proxy:', error);
		return new Response(`Proxy error: ${error.message}`, {
			status: 500,
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'text/plain',
			},
		});
	}
}

export default proxy;
