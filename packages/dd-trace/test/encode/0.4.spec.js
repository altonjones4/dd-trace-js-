'use strict'

require('../setup/tap')

const { expect } = require('chai')
const msgpack = require('@msgpack/msgpack')
const id = require('../../src/id')

function randString (length) {
  return Array.from({ length }, () => {
    return String.fromCharCode(Math.floor(Math.random() * 256))
  }).join('')
}

describe('encode', () => {
  let encoder
  let writer
  let logger
  let data

  beforeEach(() => {
    logger = {
      debug: sinon.stub()
    }
    const { AgentEncoder } = proxyquire('../src/encode/0.4', {
      '../log': logger
    })
    writer = { flush: sinon.spy() }
    encoder = new AgentEncoder(writer)
    data = [{
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      name: 'test',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo',
      error: 0,
      meta: {
        bar: 'baz'
      },
      metrics: {
        example: 1
      },
      start: 123,
      duration: 456,
      links: []
    }]
  })

  it('should encode to msgpack', () => {
    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const trace = decoded[0]

    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Object)
    expect(trace[0].trace_id.toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0].span_id.toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0].parent_id.toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0].start).to.equal(123n)
    expect(trace[0].duration).to.equal(456n)
    expect(trace[0].name).to.equal(data[0].name)
    expect(trace[0].meta).to.deep.equal({ bar: 'baz' })
    expect(trace[0].metrics).to.deep.equal({ example: 1 })
  })

  it('should truncate long IDs', () => {
    data[0].trace_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].span_id = id('ffffffffffffffff1234abcd1234abcd')
    data[0].arent_id = id('ffffffffffffffff1234abcd1234abcd')

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const trace = decoded[0]

    expect(trace[0].trace_id.toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0].span_id.toString(16)).to.equal('1234abcd1234abcd')
    expect(trace[0].parent_id.toString(16)).to.equal('1234abcd1234abcd')
  })

  it('should report its count', () => {
    expect(encoder.count()).to.equal(0)

    encoder.encode(data)

    expect(encoder.count()).to.equal(1)

    encoder.encode(data)

    expect(encoder.count()).to.equal(2)
  })

  it('should flush when the payload size limit is reached', function () {
    // Make 8mb of data
    for (let i = 0; i < 8 * 1024; i++) {
      data[0].meta[`foo${i}`] = randString(1024)
    }

    encoder.encode(data)

    expect(writer.flush).to.have.been.called
  })

  it('should reset after making a payload', () => {
    encoder.encode(data)
    encoder.makePayload()

    const payload = encoder.makePayload()

    expect(encoder.count()).to.equal(0)
    expect(payload).to.have.length(5)
    expect(payload[0]).to.equal(0xdd)
    expect(payload[1]).to.equal(0)
    expect(payload[2]).to.equal(0)
    expect(payload[3]).to.equal(0)
    expect(payload[4]).to.equal(0)
  })

  it('should log adding an encoded trace to the buffer if enabled', () => {
    encoder._debugEncoding = true
    encoder.encode(data)

    const message = logger.debug.firstCall.args[0]()

    expect(message).to.match(/^Adding encoded trace to buffer:(\s[a-f\d]{2})+$/)
  })

  it('should not log adding an encoded trace to the buffer by default', () => {
    encoder.encode(data)

    expect(logger.debug).to.not.have.been.called
  })

  it('should work when the buffer is resized', function () {
    // big enough to trigger a resize
    const dataToEncode = Array(15000).fill({
      trace_id: id('1234abcd1234abcd'),
      span_id: id('1234abcd1234abcd'),
      parent_id: id('1234abcd1234abcd'),
      name: 'bigger name than expected',
      resource: 'test-r',
      service: 'test-s',
      type: 'foo',
      error: 0,
      meta: {
        bar: 'baz'
      },
      metrics: {
        example: 1,
        moreExample: 2
      },
      start: 123,
      duration: 456
    })
    encoder.encode(dataToEncode)

    const buffer = encoder.makePayload()
    const [decodedPayload] = msgpack.decode(buffer, { useBigInt64: true })
    decodedPayload.forEach(decodedData => {
      expect(decodedData).to.include({
        name: 'bigger name than expected',
        resource: 'test-r',
        service: 'test-s',
        type: 'foo',
        error: 0
      })
      expect(decodedData.start).to.equal(123n)
      expect(decodedData.duration).to.equal(456n)
      expect(decodedData.meta).to.eql({
        bar: 'baz'
      })
      expect(decodedData.metrics).to.eql({
        example: 1,
        moreExample: 2
      })
      expect(decodedData.trace_id.toString(16)).to.equal('1234abcd1234abcd')
      expect(decodedData.span_id.toString(16)).to.equal('1234abcd1234abcd')
      expect(decodedData.parent_id.toString(16)).to.equal('1234abcd1234abcd')
    })
  })

  it('should encode span events', () => {
    const encodedLink = '[{"name":"Something went so wrong","time_unix_nano":1000000},' +
    '{"name":"I can sing!!! acbdefggnmdfsdv k 2e2ev;!|=xxx","time_unix_nano":1633023102000000,' +
    '"attributes":{"emotion":"happy","rating":9.8,"other":[1,9.5,1],"idol":false}}]'

    data[0].meta.events = encodedLink

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const trace = decoded[0]
    expect(trace[0].meta.events).to.deep.equal(encodedLink)
  })

  it('should encode spanLinks', () => {
    const traceIdHigh = id('10')
    const traceId = id('1234abcd1234abcd')
    const rootTid = traceIdHigh.toString(16).padStart(16, '0')
    const rootT64 = traceId.toString(16).padStart(16, '0')
    const traceIdVal = `${rootTid}${rootT64}`

    const encodedLink = `[{"trace_id":"${traceIdVal}","span_id":"1234abcd1234abcd",` +
    '"attributes":{"foo":"bar"},"tracestate":"dd=s:-1;o:foo;t.dm:-4;t.usr.id:bar","flags":1}]'

    data[0].meta['_dd.span_links'] = encodedLink

    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const trace = decoded[0]
    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Object)
    expect(trace[0].trace_id.toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0].span_id.toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0].parent_id.toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0].start).to.equal(123n)
    expect(trace[0].duration).to.equal(456n)
    expect(trace[0].name).to.equal(data[0].name)
    expect(trace[0].meta).to.deep.equal({ bar: 'baz', '_dd.span_links': encodedLink })
    expect(trace[0].metrics).to.deep.equal({ example: 1 })
  })

  it('should encode spanLinks with just span and trace id', () => {
    const traceId = '00000000000000001234abcd1234abcd'
    const spanId = '1234abcd1234abcd'
    const encodedLink = `[{"trace_id":"${traceId}","span_id":"${spanId}"}]`
    data[0].meta['_dd.span_links'] = encodedLink
    encoder.encode(data)

    const buffer = encoder.makePayload()
    const decoded = msgpack.decode(buffer, { useBigInt64: true })
    const trace = decoded[0]
    expect(trace).to.be.instanceof(Array)
    expect(trace[0]).to.be.instanceof(Object)
    expect(trace[0].trace_id.toString(16)).to.equal(data[0].trace_id.toString())
    expect(trace[0].span_id.toString(16)).to.equal(data[0].span_id.toString())
    expect(trace[0].parent_id.toString(16)).to.equal(data[0].parent_id.toString())
    expect(trace[0].start).to.equal(123n)
    expect(trace[0].duration).to.equal(456n)
    expect(trace[0].name).to.equal(data[0].name)
    expect(trace[0].meta).to.deep.equal({ bar: 'baz', '_dd.span_links': encodedLink })
    expect(trace[0].metrics).to.deep.equal({ example: 1 })
  })

  describe('meta_struct', () => {
    it('should encode meta_struct with simple key value object', () => {
      const metaStruct = {
        foo: 'bar',
        baz: 123
      }
      data[0].meta_struct = metaStruct
      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]

      expect(msgpack.decode(trace[0].meta_struct.foo)).to.be.equal(metaStruct.foo)
      expect(msgpack.decode(trace[0].meta_struct.baz)).to.be.equal(metaStruct.baz)
    })

    it('should ignore array in meta_struct', () => {
      const metaStruct = ['one', 2, 'three', 4, 5, 'six']
      data[0].meta_struct = metaStruct
      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]
      expect(trace[0].meta_struct).to.deep.equal({})
    })

    it('should encode meta_struct with empty object and array', () => {
      const metaStruct = {
        foo: {},
        bar: []
      }
      data[0].meta_struct = metaStruct
      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]
      expect(msgpack.decode(trace[0].meta_struct.foo)).to.deep.equal(metaStruct.foo)
      expect(msgpack.decode(trace[0].meta_struct.bar)).to.deep.equal(metaStruct.bar)
    })

    it('should encode meta_struct with possible real use case', () => {
      const metaStruct = {
        '_dd.stack': {
          exploit: [
            {
              type: 'test',
              language: 'nodejs',
              id: 'someuuid',
              message: 'Threat detected',
              frames: [
                {
                  id: 0,
                  file: 'test.js',
                  line: 1,
                  column: 31,
                  function: 'test'
                },
                {
                  id: 1,
                  file: 'test2.js',
                  line: 54,
                  column: 77,
                  function: 'test'
                },
                {
                  id: 2,
                  file: 'test.js',
                  line: 1245,
                  column: 41,
                  function: 'test'
                },
                {
                  id: 3,
                  file: 'test3.js',
                  line: 2024,
                  column: 32,
                  function: 'test'
                }
              ]
            }
          ]
        }
      }
      data[0].meta_struct = metaStruct

      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]
      expect(msgpack.decode(trace[0].meta_struct['_dd.stack'])).to.deep.equal(metaStruct['_dd.stack'])
    })

    it('should encode meta_struct ignoring circular references in objects', () => {
      const circular = {
        bar: 'baz',
        deeper: {
          foo: 'bar'
        }
      }
      circular.deeper.circular = circular
      const metaStruct = {
        foo: circular
      }
      data[0].meta_struct = metaStruct

      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]

      const expectedMetaStruct = {
        foo: {
          bar: 'baz',
          deeper: {
            foo: 'bar'
          }
        }
      }
      expect(msgpack.decode(trace[0].meta_struct.foo)).to.deep.equal(expectedMetaStruct.foo)
    })

    it('should encode meta_struct ignoring circular references in arrays', () => {
      const circular = [{
        bar: 'baz'
      }]
      circular.push(circular)
      const metaStruct = {
        foo: circular
      }
      data[0].meta_struct = metaStruct

      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]

      const expectedMetaStruct = {
        foo: [{
          bar: 'baz'
        }]
      }
      expect(msgpack.decode(trace[0].meta_struct.foo)).to.deep.equal(expectedMetaStruct.foo)
    })

    it('should encode meta_struct ignoring undefined properties', () => {
      const metaStruct = {
        foo: 'bar',
        undefinedProperty: undefined
      }
      data[0].meta_struct = metaStruct

      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]

      const expectedMetaStruct = {
        foo: 'bar'
      }
      expect(msgpack.decode(trace[0].meta_struct.foo)).to.deep.equal(expectedMetaStruct.foo)
      expect(trace[0].meta_struct.undefinedProperty).to.be.undefined
    })

    it('should encode meta_struct ignoring null properties', () => {
      const metaStruct = {
        foo: 'bar',
        nullProperty: null
      }
      data[0].meta_struct = metaStruct

      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]

      const expectedMetaStruct = {
        foo: 'bar'
      }
      expect(msgpack.decode(trace[0].meta_struct.foo)).to.deep.equal(expectedMetaStruct.foo)
      expect(trace[0].meta_struct.nullProperty).to.be.undefined
    })

    it('should not encode null meta_struct', () => {
      data[0].meta_struct = null

      encoder.encode(data)

      const buffer = encoder.makePayload()

      const decoded = msgpack.decode(buffer, { useBigInt64: true })
      const trace = decoded[0]

      expect(trace[0].meta_struct).to.be.undefined
    })
  })
})
