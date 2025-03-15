type str = string
type num = number
type bool = boolean
type Buf = BufferSource
type Func = (...args: any[]) => any

interface String {
	align(limit: num, char?: str, endPosition?: bool): str
}

interface Number {
	bytes(): str
	duration(ms?: bool): str
}
