import qrcode from 'qr'

// When the client receive the login QR-Code
export default function (qr: str) {
	console.log('LOGIN', 'QR-Code received', 'green')
	qrcode.generate(qr, { small: true })
}
