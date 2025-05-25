import { handleRequest } from '../utils/handler'; // Đảm bảo đường dẫn này đúng với cấu trúc dự án của bạn

// --- Cấu hình quan trọng: Header "ảnh" cần kiểm tra và xóa ---
// TODO: BẠN CẦN CẬP NHẬT CHUỖI BYTE NÀY!
// Đây là 7 byte đầu của chữ ký PNG tiêu chuẩn làm ví dụ.
// Hãy thay thế bằng 7 byte (hoặc số lượng byte chính xác) của header "ảnh" mà bạn muốn xóa.
// Ví dụ: const EXPECTED_HEADER_BYTES = [137, 80, 78, 71, 13, 10, 26]; (dạng số thập phân)
const EXPECTED_HEADER_BYTES = [137, 80, 78, 71, 13, 10, 26]; // << THAY ĐỔI CÁI NÀY!!!
const BYTES_TO_CHECK_AND_STRIP = EXPECTED_HEADER_BYTES.length;

/**
 * Xử lý nội dung M3U8 để proxy các URL bên trong.
 * Tìm và thay thế các URL trong thuộc tính URI="..." (ví dụ: #EXT-X-KEY, #EXT-X-MAP)
 * và các URL đứng riêng một dòng (segment .ts hoặc playlist M3U8 con).
 */
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
					console.error(`Error processing M3U8 URI attribute: ${uriMatch.groups.uri} in line "${line}"`, error);
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
					console.error(`Error processing M3U8 segment/playlist URL: ${line.trim()}`, error);
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
			throw new Error(`HTTP error! status: ${response.status} for ${mediaUrl}`);
		}

		const cleanHeaders = Object.fromEntries(
			Array.from(response.headers.entries()).filter(([key], i, arr) => arr.findIndex(([k]) => k.toLowerCase() === key.toLowerCase()) === i)
		);
		delete cleanHeaders['Access-Control-Allow-Origin'];
		delete cleanHeaders['access-control-allow-origin'];
		// Giữ lại Content-Length và Content-Range gốc từ server nếu có,
		// chúng sẽ được trình duyệt/runtime điều chỉnh nếu nội dung Response thay đổi.
		const responseHeaders = {
			...cleanHeaders,
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Expose-Headers': Object.keys(cleanHeaders).join(', '),
		};

		const contentType = response.headers.get('Content-Type') || '';
		let responseContentAsText = await response.text();
		const contentLooksLikeM3U8 = responseContentAsText.trimStart().startsWith('#EXTM3U');

		const isM3U8 =
			contentLooksLikeM3U8 ||
			contentType.includes('application/vnd.apple.mpegurl') ||
			contentType.includes('application/x-mpegurl') ||
			contentType.includes('audio/mpegurl') ||
			contentType.includes('audio/x-mpegurl');

		if (isM3U8) {
			const processedM3U8Content = processM3U8Content(responseContentAsText, mediaUrl, origin, decodedHeaders);
			responseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
			return new Response(processedM3U8Content, {
				status: response.status,
				headers: responseHeaders,
			});
		}

		const hasManyNonPrintable =
			responseContentAsText.split('').filter((char) => char.charCodeAt(0) < 32 && char !== '\n' && char !== '\r' && char !== '\t').length >
			responseContentAsText.length * 0.1;

		if (
			hasManyNonPrintable ||
			contentType.startsWith('video/') || // Kiểm tra video/
			contentType.startsWith('audio/') || // Kiểm tra audio/
			contentType.startsWith('image/') || // Kiểm tra image/ (trường hợp segment bị giả mạo)
			contentType.includes('application/octet-stream')
		) {
			const binaryResponse = await fetch(mediaUrl, {
				headers: fetchHeaders,
			});
			if (!binaryResponse.ok) {
				throw new Error(`HTTP error on binary re-fetch! status: ${binaryResponse.status} for ${mediaUrl}`);
			}
			let arrayBuffer = await binaryResponse.arrayBuffer();
			let wasHeaderStripped = false;

			// Chỉ xóa header nếu KHÔNG có Range header và các điều kiện khác thỏa mãn
			if (!fetchHeaders['Range'] && arrayBuffer.byteLength >= BYTES_TO_CHECK_AND_STRIP && EXPECTED_HEADER_BYTES.length > 0) {
				const firstBytes = new Uint8Array(arrayBuffer, 0, BYTES_TO_CHECK_AND_STRIP);
				let matchesHeader = true;
				for (let i = 0; i < BYTES_TO_CHECK_AND_STRIP; i++) {
					if (firstBytes[i] !== EXPECTED_HEADER_BYTES[i]) {
						matchesHeader = false;
						break;
					}
				}
				if (matchesHeader) {
					console.log(`Header matched for ${mediaUrl}. Original length: ${arrayBuffer.byteLength}. Stripping ${BYTES_TO_CHECK_AND_STRIP} bytes.`);
					arrayBuffer = arrayBuffer.slice(BYTES_TO_CHECK_AND_STRIP);
					wasHeaderStripped = true;
					console.log(`New length for ${mediaUrl} after stripping: ${arrayBuffer.byteLength}.`);
				} else {
					console.log(`Header did NOT match for ${mediaUrl} (no Range request). Original length: ${arrayBuffer.byteLength}.`);
				}
			} else if (fetchHeaders['Range']) {
				console.log(`Range header [${fetchHeaders['Range']}] present, skipping header stripping for segment: ${mediaUrl}`);
			} else if (EXPECTED_HEADER_BYTES.length === 0) {
				console.log(`Header stripping is disabled (EXPECTED_HEADER_BYTES is empty) for segment: ${mediaUrl}`);
			} else {
				console.log(`Segment ${mediaUrl} too short (${arrayBuffer.byteLength} bytes) or header check not applicable.`);
			}

			if (wasHeaderStripped) {
				const actualVideoContentType = 'video/mp2t'; // Đã xác nhận từ bạn
				const originalContentTypeFromServer = binaryResponse.headers.get('Content-Type') || '';
				responseHeaders['Content-Type'] = actualVideoContentType;
				console.log(`Header stripped for ${mediaUrl}. Original Content-Type from server: '${originalContentTypeFromServer}'. Setting Content-Type to '${actualVideoContentType}'.`);
			}
			
			// Nếu là Range request, status nên là 206. Nếu không, dùng status từ binaryResponse.
			// fetchHeaders['Range'] là range client gửi cho proxy.
			// binaryResponse.status là status server gốc trả về (có thể là 200 hoặc 206).
			// Nếu client yêu cầu range, proxy yêu cầu range, server gốc trả 206 -> binaryResponse.status là 206.
			// Nếu client không yêu cầu range, proxy không yêu cầu range, server gốc trả 200 -> binaryResponse.status là 200.
			// Nếu wasHeaderStripped và không có Range request, status là 200.
			// Nếu không có Range request và không strip, status là 200.
			// Về cơ bản, status của binaryResponse là phù hợp.
			return new Response(arrayBuffer, {
				status: binaryResponse.status,
				headers: responseHeaders,
			});
		}

		return new Response(responseContentAsText, {
			status: response.status,
			headers: responseHeaders,
		});

	} catch (error) {
		console.error('Error in proxy:', error.message, error.stack);
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
