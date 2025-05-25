import { handleRequest } from '../utils/handler'; // Đảm bảo đường dẫn này đúng

// --- Cấu hình quan trọng ---
// 1. Chữ ký PNG tiêu chuẩn (8 byte) để kiểm tra
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]; // 8 byte chữ ký PNG
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length; // Sẽ là 8

// 2. TỔNG SỐ BYTE CẦN XÓA để đến được dữ liệu TS
// Giá trị này được xác định từ phân tích file mẫu của bạn,
// là offset từ đầu file đến byte 0x47 đầu tiên của luồng TS.
const TOTAL_OFFSET_TO_TS_DATA = 7478;

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
			contentType.startsWith('video/') ||
			contentType.startsWith('audio/') ||
			contentType.startsWith('image/') || // Xử lý trường hợp segment bị giả mạo thành ảnh
			contentType.includes('application/octet-stream')
		) {
			const binaryResponse = await fetch(mediaUrl, { // Fetch lại để lấy ArrayBuffer
				headers: fetchHeaders,
			});
			if (!binaryResponse.ok) {
				throw new Error(`HTTP error on binary re-fetch! status: ${binaryResponse.status} for ${mediaUrl}`);
			}
			let arrayBuffer = await binaryResponse.arrayBuffer();
			let wasHeaderStripped = false;

			// Chỉ xóa header nếu KHÔNG có Range header và đủ độ dài để chứa toàn bộ phần header "ảnh"
			if (!fetchHeaders['Range'] && arrayBuffer.byteLength >= TOTAL_OFFSET_TO_TS_DATA && PNG_SIGNATURE.length > 0) {
				const firstPngSignatureBytes = new Uint8Array(arrayBuffer, 0, PNG_SIGNATURE_LENGTH);
				let matchesPngSignature = true;
				for (let i = 0; i < PNG_SIGNATURE_LENGTH; i++) {
					if (firstPngSignatureBytes[i] !== PNG_SIGNATURE[i]) {
						matchesPngSignature = false;
						break;
					}
				}

				if (matchesPngSignature) {
					console.log(`PNG signature matched for ${mediaUrl}. Original length: ${arrayBuffer.byteLength}. Stripping ${TOTAL_OFFSET_TO_TS_DATA} bytes to reach TS data.`);
					arrayBuffer = arrayBuffer.slice(TOTAL_OFFSET_TO_TS_DATA); // Xóa toàn bộ phần header "ảnh"
					wasHeaderStripped = true;
					console.log(`New length for ${mediaUrl} after stripping: ${arrayBuffer.byteLength}.`);
				} else {
					console.log(`PNG signature NOT matched for ${mediaUrl}. Not stripping. Original length: ${arrayBuffer.byteLength}.`);
				}
			} else if (fetchHeaders['Range']) {
				console.log(`Range header [${fetchHeaders['Range']}] present, skipping header stripping for segment: ${mediaUrl}`);
			} else if (PNG_SIGNATURE.length === 0) { // Trường hợp không muốn kiểm tra signature PNG
				console.log(`PNG signature check is disabled (PNG_SIGNATURE is empty). Stripping ${TOTAL_OFFSET_TO_TS_DATA} bytes directly if no Range header and length permits.`);
                if (!fetchHeaders['Range'] && arrayBuffer.byteLength >= TOTAL_OFFSET_TO_TS_DATA) {
                    arrayBuffer = arrayBuffer.slice(TOTAL_OFFSET_TO_TS_DATA);
                    wasHeaderStripped = true;
                }
			} else { // Các trường hợp khác: arrayBuffer quá ngắn, v.v.
				console.log(`Segment ${mediaUrl} too short (${arrayBuffer.byteLength} bytes for offset ${TOTAL_OFFSET_TO_TS_DATA}), or PNG_SIGNATURE check not applicable/failed, or Range header present. Not stripping.`);
			}

			if (wasHeaderStripped) {
				const actualVideoContentType = 'video/mp2t'; // Đã xác nhận
				const originalContentTypeFromServer = binaryResponse.headers.get('Content-Type') || '';
				responseHeaders['Content-Type'] = actualVideoContentType;
				console.log(`Header stripped for ${mediaUrl}. Original Content-Type from server: '${originalContentTypeFromServer}'. Setting Content-Type to '${actualVideoContentType}'.`);
			}
			
            // Log các byte đầu của dữ liệu gửi đi (rất quan trọng để kiểm tra)
			if (arrayBuffer.byteLength > 0) {
                const firstFewBytesOfOutput = new Uint8Array(arrayBuffer, 0, Math.min(20, arrayBuffer.byteLength));
                const byteString = Array.from(firstFewBytesOfOutput).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ');
                console.log(`Proxy sending segment for ${mediaUrl}:`);
                console.log(`  - Content-Type: ${responseHeaders['Content-Type']}`);
                console.log(`  - Was header stripped: ${wasHeaderStripped}`);
                console.log(`  - Final ArrayBuffer length: ${arrayBuffer.byteLength} bytes`);
                console.log(`  - First few bytes of data being sent: [${byteString}]`);
                if (firstFewBytesOfOutput[0] === 0x47) { // 0x47 là 71 ở dạng thập phân
                    console.log("  - INFO: First byte IS 0x47 (TS sync byte) - EXCELLENT SIGN!");
                } else {
                    console.log(`  - WARNING: First byte IS 0x${firstFewBytesOfOutput[0]?.toString(16).padStart(2, '0')}. Expected 0x47 for TS. This might still be an issue.`);
                }
            } else {
                console.log(`Proxy sending EMPTY segment for ${mediaUrl} (Content-Type: ${responseHeaders['Content-Type']}) after processing.`);
            }
            
			return new Response(arrayBuffer, {
				status: binaryResponse.status, // Giữ status từ server gốc (có thể là 200 hoặc 206)
				headers: responseHeaders,
			});
		}

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
