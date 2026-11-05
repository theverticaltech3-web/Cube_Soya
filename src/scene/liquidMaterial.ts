import * as THREE from 'three'

const vertexShader = /* glsl */ `
  attribute vec3 aOffset;
  attribute vec3 aSize;
  attribute vec4 aQuat;
  attribute vec3 aSurface; // liquid amount, tint, hover
  attribute float aHide; // fades a piece into the background

  uniform float uRadius;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vSurface;
  varying float vEdge;
  varying float vHide;

  vec3 rotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    // Rebuild the rounded box at this piece's size, so the corners never stretch.
    float radius = min(uRadius, min(aSize.x, min(aSize.y, aSize.z)) * 0.5);
    vec3 local = sign(position) * (aSize * 0.5 - radius) + normal * radius;

    vec4 world = modelMatrix * vec4(rotate(aQuat, local) + aOffset, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * rotate(aQuat, normal));
    vSurface = aSurface;
    vEdge = 1.0 - abs(normal.y);
    vHide = aHide;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uTheme;
  uniform float uSweep;
  uniform float uAlign;
  uniform float uScale;
  uniform vec3 uBg;
  uniform vec3 uBlue;
  uniform vec3 uCream;

  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vSurface;
  varying float vEdge;
  varying float vHide;

  // Repeated warping gives the slow, folding look of water.
  float liquid(vec3 p) {
    float t = uTime * 0.28;
    for (int i = 0; i < 4; i++) {
      p += 0.6 * sin(p.yzx * 1.7 + t + float(i) * 1.3);
    }
    return 0.5 + 0.5 * sin(p.x + p.y * 0.7 - p.z * 0.6);
  }

  // Dark studio with one wide softbox above and one strip on the side.
  float studio(vec3 r) {
    float top = smoothstep(0.35, 0.95, r.y);
    float strip = smoothstep(0.1, 0.0, abs(r.x - 0.55)) * smoothstep(-0.6, 0.3, r.y);
    return top * 0.9 + strip * 0.7;
  }

  void main() {
    if (vHide > 0.995) discard;

    vec3 view = normalize(cameraPosition - vWorld);
    vec3 geometric = normalize(vNormal);

    // From the one correct angle the cubes share a single painting, flattened onto the screen.
    vec3 flattened = vec3(vWorld.xy * cameraPosition.z / (cameraPosition.z - vWorld.z), 0.0);
    vec3 q = mix(vWorld, flattened, uAlign) * uScale;
    float field = liquid(q);
    vec2 slope = vec2(liquid(q + vec3(0.06, 0.0, 0.0)), liquid(q + vec3(0.0, 0.06, 0.0))) - field;

    float amount = vSurface.x;
    float tint = vSurface.y;
    float hover = clamp(vSurface.z, 0.0, 1.0);

    // The liquid spreads with a torn edge, like in the reference video.
    float grow = max(amount, hover * 0.92);
    float mask = smoothstep(0.0, 0.14, grow * 1.14 - field * (1.0 - grow));
    float rim = smoothstep(0.0, 0.1, mask) * (1.0 - smoothstep(0.1, 0.65, mask));

    vec3 normal = normalize(geometric + vec3(slope * 2.6, 0.0) * mask);
    vec3 reflected = reflect(-view, normal);
    float facing = max(dot(geometric, view), 0.0);
    float fresnel = pow(1.0 - facing, 3.5);

    float pearl = smoothstep(1.5, 2.0, tint);

    // Black gloss: the surface the box starts with.
    // A slight ripple keeps flat faces from reading as plastic.
    vec3 rippled = normalize(geometric + vec3(slope * 0.9, 0.0));
    float light = studio(reflect(-view, rippled));
    float sheen = smoothstep(0.3, 0.75, field);
    vec3 gloss = vec3(0.005, 0.006, 0.01) + mix(uBlue, uCream, 0.35) * light * sheen * mix(0.09, 0.045, uTheme);
    gloss += fresnel * mix(uBlue * 0.34, uCream * 0.16, uTheme);
    gloss += mix(uBlue, uCream, pearl) * smoothstep(0.5, 1.0, vEdge) * 0.16; // each tile's color shows through the seams

    // Liquid: chrome bands of blue and cream, led by the cube's own color.
    float band = fract(reflected.y * 0.5 + 0.4 + field * 0.85);
    vec3 deep = uBlue * mix(0.12, 0.62, pearl);
    vec3 surface = mix(deep, uBlue, smoothstep(0.06, 0.5, band));
    surface = mix(surface, uCream, smoothstep(mix(0.8, 0.24, pearl), mix(0.92, 0.52, pearl), band));
    surface = mix(surface, mix(uBlue, deep, pearl), smoothstep(0.92, 1.0, band) * (1.0 - pearl * 0.6));
    surface *= mix(0.22, 1.0, smoothstep(0.3, 0.75, amount)); // stays a faint glow while the box is shut
    surface = mix(surface, uBlue, hover * 0.6 * (1.0 - smoothstep(0.65, 0.8, band)));
    surface += uCream * fresnel * 0.3 * amount;

    vec3 color = mix(gloss, surface, mask);
    color += uCream * rim * 0.55;

    // A band of light crosses the finished keyboard.
    float sweep = exp(-pow(vWorld.x * 0.42 - uSweep, 2.0) * 22.0);
    color += (uBlue * 0.3 + uCream * 0.06) * sweep * smoothstep(0.2, 0.9, max(geometric.y, geometric.z));

    // Sharp highlight, what makes it read as wet rather than plastic.
    float highlight = pow(max(dot(reflected, normalize(vec3(0.4, 0.8, 0.45))), 0.0), 90.0);
    color += uCream * highlight * (0.35 + mask * 0.5);

    gl_FragColor = vec4(mix(color, uBg, vHide), 1.0);
    #include <colorspace_fragment>
  }
`

export const createLiquidMaterial = () =>
  new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uTheme: { value: 0 },
      uSweep: { value: -9 },
      uAlign: { value: 0 },
      uScale: { value: 1.25 },
      uBg: { value: new THREE.Color('#08090C') },
      uRadius: { value: 0.055 },
      uBlue: { value: new THREE.Color('#1C70EC') },
      uCream: { value: new THREE.Color('#FFFCF0') },
    },
  })
