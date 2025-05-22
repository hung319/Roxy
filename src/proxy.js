import { handleRequest } from '../utils/handler'; // Giả định bạn có hàm này để trích xuất URL, headers, origin

function processM3U8Content(content, mediaUrl, origin, headers) {
	const hasHeaders = headers && Object.keys(headers).length > 0;
	// Mã hóa headers để truyền qua query param một cách an toàn
	const _headers = hasHeaders ? `&headers=${encodeURIComponent(btoa(JSON.stringify(headers)))}` : '';
	return content
		.split('\n')
		.map((line) => {
			const uriMatch = line.match(/(URI=)(["'])(?<uri>.*?)\2/);
			if (uriMatch) {
				const [fullMatch, prefix, quote] = uriMatch;
				try {
					const resolvedUrl = new URL(uriMatch.groups.uri, mediaUrl).toString();
					// Không thêm segmentRole cho key URI
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}${_headers}`;
					return line.replace(fullMatch, `${prefix}${quote}${proxyUrl}${quote}`);
				} catch (error) {
					console.error('Error processing URI in M3U8:', uriMatch.groups.uri, error);
					return line; // Trả về dòng gốc nếu có lỗi
				}
			}

			// Bỏ qua các dòng comment và các thẻ đặc biệt không phải là URL segment trực tiếp
			// mà có thể chứa URL (ví dụ: EXT-X-MEDIA với URI) cần xử lý riêng nếu có
			if (line.startsWith('#EXT-X-STREAM-INF') || line.startsWith('#EXT-X-I-FRAME-STREAM-INF') || line.startsWith('#EXT-X-MEDIA:') ) {
				// Nếu #EXT-X-MEDIA có URI, nó cũng cần được proxy.
				// Logic hiện tại không xử lý URI trong #EXT-X-MEDIA, chỉ tập trung vào URI trong #EXT-X-KEY và các segment lines.
				// Bạn có thể mở rộng điều này nếu cần.
				return line;
			}

			// Nếu dòng không bắt đầu bằng '#' và có nội dung, coi đó là URL của segment media
			if (!line.startsWith('#') && line.trim()) {
				try {
					const resolvedUrl = new URL(line.trim(), mediaUrl).toString();
					// Thêm &segmentRole=media để gợi ý cho hàm proxy rằng đây là segment media
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}&segmentRole=media${_headers}`;
					return proxyUrl;
				} catch (error) {
					console.error('Error processing segment URL in M3U8:', line.trim(), error);
					return line; // Trả về dòng gốc nếu có lỗi
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
				'Access-Control-Allow-Methods': 'GET, OPTIONS', // Bao gồm các method bạn hỗ trợ
				'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, X-Custom-Header', // Các header client có thể gửi
				'Access-Control-Max-Age': '86400', // Thời gian cache preflight request
			},
		});
	}

	try {
		// Trích xuất thông tin từ request.
		// Thay thế phần này bằng cách bạn gọi handleRequest hoặc trích xuất trực tiếp.
		const requestUrlObject = new URL(request.url);
		const mediaUrlFromQuery = requestUrlObject.searchParams.get('url');
		const headersFromQueryParam = requestUrlObject.searchParams.get('headers'); // Headers được mã hóa từ M3U8
		const segmentRole = requestUrlObject.searchParams.get('segmentRole');
		const origin = `${requestUrlObject.protocol}//${requestUrlObject.host}`;

		if (!mediaUrlFromQuery) {
			return new Response('Missing url parameter', { 
				status: 400, 
				headers: { 'Access-Control-Allow-Origin': '*' } 
			});
		}
		
		// Giải mã mediaUrl nếu cần (thường không cần nếu nó không được btoa từ client)
		let mediaUrl = decodeURIComponent(mediaUrlFromQuery);
		// Ví dụ: nếu bạn luôn btoa mediaUrl khi gọi /proxy
		// try { mediaUrl = atob(mediaUrlFromQuery); } catch(e) { mediaUrl = decodeURIComponent(mediaUrlFromQuery); }


		let decodedHeadersFromM3U8 = {}; // Headers được truyền từ M3U8 cho segment/key cụ thể
		if (headersFromQueryParam) {
			try {
				decodedHeadersFromM3U8 = JSON.parse(atob(decodeURIComponent(headersFromQueryParam)));
			} catch (e) {
				console.error('Failed to parse headers from M3U8 query param:', e);
			}
		}
		
		// Headers từ request gốc của client đến proxy (ví dụ: Range)
		const clientRequestHeaders = {};
		if (request.headers.get('Range')) {
			clientRequestHeaders['Range'] = request.headers.get('Range');
		}
		// Thêm các header khác từ client request nếu cần, ví dụ: Authorization
		// if (request.headers.get('Authorization')) {
		// 	clientRequestHeaders['Authorization'] = request.headers.get('Authorization');
		// }


		const fetchHeaders = {
			'User-Agent':
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/237.84.2.178 Safari/537.36',
			Connection: 'keep-alive',
			...decodedHeadersFromM3U8, // Ưu tiên headers từ M3U8 (nếu có cho key/segment)
			...clientRequestHeaders,    // Sau đó là headers từ client request (như Range)
		};


		const originResponse = await fetch(mediaUrl, {
			headers: fetchHeaders,
			redirect: 'follow', // Cho phép redirect từ server gốc
		});

		if (!originResponse.ok) {
			// Log thêm thông tin lỗi từ server gốc
			const errorBody = await originResponse.text().catch(() => "Could not read error body");
			console.error(`HTTP error! status: ${originResponse.status} for ${mediaUrl}. Body: ${errorBody}`);
			return new Response(`Upstream server error: ${originResponse.status}. ${errorBody}`, {
				status: originResponse.status > 399 && originResponse.status < 600 ? originResponse.status : 500, // Trả về status code hợp lý
				headers: { 
					'Access-Control-Allow-Origin': '*',
					'Content-Type': originResponse.headers.get('Content-Type') || 'text/plain',
				 },
			});
		}

		// Chuẩn bị headers cho phản hồi gửi về client từ proxy
		const cleanHeaders = Object.fromEntries(
			Array.from(originResponse.headers.entries()).filter(([key], i, arr) => {
				const lowerKey = key.toLowerCase();
				// Loại bỏ các header không nên proxy hoặc sẽ được ghi đè
				if (lowerKey === 'access-control-allow-origin' || 
					lowerKey === 'access-control-allow-credentials' ||
					lowerKey === 'access-control-expose-headers' ||
					lowerKey === 'access-control-max-age' ||
					lowerKey === 'access-control-allow-methods' ||
					lowerKey === 'access-control-allow-headers' ||
					lowerKey === 'connection' || // Thường do client/proxy quản lý
					lowerKey === 'transfer-encoding' || // Thường là chunked, proxy sẽ xử lý
					lowerKey.startsWith('cf-') || // Cloudflare specific headers
					lowerKey.startsWith('x-amz-') // AWS specific headers (có thể muốn giữ một số)
				) {
					return false;
				}
				return arr.findIndex(([k]) => k.toLowerCase() === lowerKey) === i;
			})
		);

		const clientResponseHeaders = {
			...cleanHeaders, // Headers đã được làm sạch từ server gốc
			'Access-Control-Allow-Origin': '*', // CORS cho phép mọi nguồn
			'Access-Control-Expose-Headers': Object.keys(cleanHeaders).join(', '), // Cho phép client đọc các header này
			// 'Cache-Control': 'public, max-age=3600' // Ví dụ: thêm cache control nếu muốn
		};

		const originalContentType = (originResponse.headers.get('Content-Type') || '').toLowerCase();
		let shouldForceVideoMp2t = false;

		if (mediaUrl.toLowerCase().endsWith('.ts')) {
			shouldForceVideoMp2t = true;
		} else if (originalContentType === 'video/mp2t') {
			shouldForceVideoMp2t = true;
		} else if (segmentRole === 'media' && originalContentType !== 'video/mp4' && !originalContentType.includes('audio/')) {
			// Nếu là segment media từ M3U8, và server gốc không trả về video/mp2t (hoặc video/mp4, audio/*),
			// thì ép kiểu thành video/mp2t cho trình phát.
			// Điều này giúp xử lý trường hợp server gốc trả Content-Type sai (ví dụ: application/octet-stream)
			console.log(`Segment role 'media' for ${mediaUrl} with original Content-Type '${originalContentType}'. Forcing to video/mp2t.`);
			shouldForceVideoMp2t = true;
		}

		if (shouldForceVideoMp2t) {
			clientResponseHeaders['Content-Type'] = 'video/mp2t';
		}
		
		let finalIsM3U8 = false;
		let responseBodyAsText; // Sẽ chứa nội dung text nếu là M3U8

		const urlSuggestsM3U8 = mediaUrl.toLowerCase().endsWith('.m3u8') || mediaUrl.toLowerCase().includes('/playlist');
		const isM3U8ByOriginalContentType = originalContentType.includes('application/vnd.apple.mpegurl') ||
									originalContentType.includes('application/x-mpegurl') ||
									originalContentType.includes('audio/mpegurl') ||
									originalContentType.includes('audio/x-mpegurl');

		// Chỉ kiểm tra nội dung M3U8 nếu:
		// 1. Nó chưa bị ép kiểu thành video/mp2t (tức không phải là segment media đã xác định).
		// 2. Có dấu hiệu là M3U8 từ URL hoặc Content-Type gốc.
		if (!shouldForceVideoMp2t && (urlSuggestsM3U8 || isM3U8ByOriginalContentType)) {
			const tempResponseForText = originResponse.clone(); // Clone để đọc text mà không tiêu thụ body gốc
			try {
			    responseBodyAsText = await tempResponseForText.text();
			    if (responseBodyAsText.trimStart().startsWith('#EXTM3U')) {
				    finalIsM3U8 = true;
			    } else if (isM3U8ByOriginalContentType) {
				    // Content-Type gốc nói là M3U8, nhưng nội dung không bắt đầu bằng #EXTM3U.
				    // Coi như không phải M3U8 để tránh xử lý sai.
				    finalIsM3U8 = false;
				    console.warn(`URL: ${mediaUrl} - Content-Type (${originalContentType}) suggested M3U8, but content did not start with #EXTM3U.`);
			    }
            } catch (e) {
                // Không thể đọc text (ví dụ: file quá lớn hoặc thực sự là binary dù Content-Type báo M3U8)
                console.warn(`URL: ${mediaUrl} - Error reading text for M3U8 check (suggested by URL/ContentType). Error: ${e.message}. Treating as non-M3U8.`);
                finalIsM3U8 = false;
            }
		}


		if (finalIsM3U8) {
			// Xử lý nội dung M3U8
			const processedM3U8 = processM3U8Content(responseBodyAsText, mediaUrl, origin, decodedHeadersFromM3U8);
			clientResponseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl'; // Đảm bảo Content-Type cho M3U8
			return new Response(processedM3U8, {
				status: originResponse.status, // Giữ status gốc (thường là 200 OK)
				headers: clientResponseHeaders,
			});
		} else {
			// Không phải M3U8: có thể là segment (bao gồm .ts đã được ép Content-Type), hình ảnh, hoặc file khác.
			// Trả về body gốc của phản hồi. Điều này hiệu quả cho các tệp nhị phân.
			// clientResponseHeaders đã được cập nhật Content-Type cho .ts (nếu cần) và chứa header CORS.
			return new Response(originResponse.body, {
				status: originResponse.status,
				statusText: originResponse.statusText,
				headers: clientResponseHeaders,
			});
		}

	} catch (error) {
		console.error('Critical error in proxy:', error.message, error.stack);
		return new Response(`Proxy critical error: ${error.message}`, {
			status: 500, // Lỗi server nội bộ của proxy
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'text/plain',
			},
		});
	}
}

export default proxy;
