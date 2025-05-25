import { handleRequest } from '../utils/handler';

// --- Cải tiến #1: Khai báo header mẫu để kiểm tra ---
// TODO: Người dùng cần xác nhận hoặc thay đổi chuỗi byte này cho phù hợp với "header PNG 1x1 7 byte" cụ thể của họ.
// Ví dụ: 7 byte đầu của chữ ký PNG tiêu chuẩn (0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A)
const EXPECTED_HEADER_BYTES = [137, 80, 78, 71, 13, 10, 26]; // Dạng số thập phân
const BYTES_TO_CHECK_AND_STRIP = EXPECTED_HEADER_BYTES.length;

/**
 * --- Cải tiến #6: Xử lý nội dung M3U8 ---
 * Hàm này xử lý nội dung M3U8 để proxy các URL bên trong.
 * Nó tìm kiếm và thay thế:
 * 1. Các URL trong thuộc tính URI="...", ví dụ:
 * - #EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin"
 * - #EXT-X-MAP:URI="main.mp4"
 * - #EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"
 * 2. Các URL đứng riêng một dòng (thường là các segment .ts hoặc các playlist M3U8 con).
 *
 * Regex /(URI=)(["'])(?<uri>.*?)\2/ được sử dụng để trích xuất URI từ các thuộc tính.
 * Tất cả các URL được giải quyết tương đối với URL của M3U8 gốc (mediaUrl).
 */
function processM3U8Content(content, mediaUrl, origin, headers) {
	const hasHeaders = headers && Object.keys(headers).length > 0;
	const _headers = hasHeaders ? `&headers=${btoa(JSON.stringify(headers))}` : '';
	return content
		.split('\n')
		.map((line) => {
			// Kiểm tra các thuộc tính URI="<url>"
			const uriMatch = line.match(/(URI=)(["'])(?<uri>.*?)\2/);
			if (uriMatch) {
				const [fullMatch, prefix, quote] = uriMatch;
				try {
					const resolvedUrl = new URL(uriMatch.groups.uri, mediaUrl).toString();
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}${_headers}`;
					return line.replace(fullMatch, `${prefix}${quote}${proxyUrl}${quote}`);
				} catch (error) {
					console.error(`Error processing M3U8 URI attribute: ${uriMatch.groups.uri} in line "${line}"`, error);
					return line; // Trả về dòng gốc nếu có lỗi
				}
			}

			// Dòng #EXT-X-STREAM-INF đứng trước URL của một variant stream.
			// Bản thân dòng này không chứa URL cần proxy, URL nằm ở dòng kế tiếp.
			if (line.startsWith('#EXT-X-STREAM-INF')) {
				return line;
			}

			// Xử lý các URL đứng riêng một dòng (ví dụ: segment .ts hoặc M3U8 con)
			if (!line.startsWith('#') && line.trim()) {
				try {
					const resolvedUrl = new URL(line.trim(), mediaUrl).toString();
					const proxyUrl = `${origin}/proxy?url=${encodeURIComponent(resolvedUrl)}${_headers}`;
					return proxyUrl;
				} catch (error) {
					console.error(`Error processing M3U8 segment/playlist URL: ${line.trim()}`, error);
					return line; // Trả về dòng gốc nếu có lỗi
				}
			}

			// Trả về các dòng khác (comment, các tag không chứa URI cần proxy)
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
			throw new Error(`HTTP error! status: ${response.status} for ${mediaUrl}`);
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

		let responseContentAsText = await response.text(); // Đọc response dưới dạng text trước để kiểm tra M3U8
		const contentLooksLikeM3U8 = responseContentAsText.trimStart().startsWith('#EXTM3U');

		const isM3U8 =
			contentLooksLikeM3U8 ||
			contentType.includes('application/vnd.apple.mpegurl') ||
			contentType.includes('application/x-mpegurl') ||
			contentType.includes('audio/mpegurl') ||
			contentType.includes('audio/x-mpegurl');

		if (isM3U8) {
			const processedM3U8Content = processM3U8Content(responseContentAsText, mediaUrl, origin, decodedHeaders);
			responseHeaders['Content-Type'] = 'application/vnd.apple.mpegurl'; // Đảm bảo content type đúng
			return new Response(processedM3U8Content, {
				status: response.status,
				headers: responseHeaders,
			});
		}

		// Xử lý nội dung không phải M3U8 (bao gồm các segments)
		// if (!contentLooksLikeM3U8 && responseContentAsText.length > 0) { // Điều kiện này đã được bao hàm bởi !isM3U8
		const hasManyNonPrintable =
			responseContentAsText.split('').filter((char) => char.charCodeAt(0) < 32 && char !== '\n' && char !== '\r' && char !== '\t').length >
			responseContentAsText.length * 0.1;

		if (
			hasManyNonPrintable ||
			contentType.includes('video/') ||
			contentType.includes('audio/') ||
			contentType.includes('image/') ||
			contentType.includes('application/octet-stream')
		) {
			// Nội dung có vẻ là nhị phân, fetch lại dưới dạng ArrayBuffer
			// (Hoặc nếu response.clone() được hỗ trợ và hiệu quả, có thể dùng response.clone().arrayBuffer())
			// Tuy nhiên, fetch lại đơn giản và rõ ràng hơn trong nhiều trường hợp.
			const binaryResponse = await fetch(mediaUrl, { // Fetch lại để lấy ArrayBuffer
				headers: fetchHeaders,
			});
			if (!binaryResponse.ok) {
				throw new Error(`HTTP error on binary re-fetch! status: ${binaryResponse.status} for ${mediaUrl}`);
			}
			let arrayBuffer = await binaryResponse.arrayBuffer();

			// --- Cải tiến #1: Kiểm tra và xóa header nếu khớp ---
			if (arrayBuffer.byteLength >= BYTES_TO_CHECK_AND_STRIP && EXPECTED_HEADER_BYTES.length > 0) {
				const firstBytes = new Uint8Array(arrayBuffer, 0, BYTES_TO_CHECK_AND_STRIP);
				let matchesHeader = true;
				for (let i = 0; i < BYTES_TO_CHECK_AND_STRIP; i++) {
					if (firstBytes[i] !== EXPECTED_HEADER_BYTES[i]) {
						matchesHeader = false;
						break;
					}
				}

				if (matchesHeader) {
					// console.log(`Header matched. Stripping ${BYTES_TO_CHECK_AND_STRIP} bytes from segment: ${mediaUrl}`);
					arrayBuffer = arrayBuffer.slice(BYTES_TO_CHECK_AND_STRIP);
				} else {
					// console.log(`Header did not match. Not stripping bytes from segment: ${mediaUrl}`);
				}
			}
			// --- Kết thúc Cải tiến #1 ---

			return new Response(arrayBuffer, {
				status: binaryResponse.status, // Sử dụng status từ binaryResponse
				headers: responseHeaders,
			});
		}
		// } // Kết thúc khối if (!contentLooksLikeM3U8 ...)

		// Fallback cho các nội dung dạng text khác không phải M3U8 và không phải nhị phân theo các điều kiện trên
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
