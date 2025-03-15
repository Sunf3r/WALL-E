import qrcode from 'qr'

// When the client received QR-Code
export default function (qr: str) {
	console.log('QR RECEIVED', qr)
	qrcode.generate(qr, { small: true })
}
