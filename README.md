# Diseñador de tazas — Preview Gudink

Adelanto del editor de tazas que vamos a meter en Gudink. Es un sandbox para que prueben los socios; no está conectado a la tienda, lo que diseñan no se guarda y la base de datos no está conectada todavía.

**Probarlo:** abrir [https://alejoras.github.io/gudink-mug-preview/](https://alejoras.github.io/gudink-mug-preview/) (la URL final depende de cómo publiquemos; ver más abajo).

## Qué pueden hacer

- Subir hasta 5 imágenes (PNG / JPG / WebP) y apilarlas como capas
- Arrastrar, redimensionar y reordenar capas en el editor 2D
- Ver la previsualización 3D en vivo en la esquina inferior derecha (se actualiza mientras editan)
- Click en esa preview chica (o ir a **Preview** arriba a la derecha) para ver el mug 3D en grande, con orbit/zoom
- Generar un set de 5 mockups del producto desde distintos ángulos, listos para subir a una tienda
- Descargar el archivo de impresión a 300 DPI (lo que iría a producción)

## Qué nos importa que prueben

- ¿Se siente intuitivo el flujo de edición?
- ¿Los controles están claros?
- ¿La preview en vivo aporta o es ruido?
- ¿Los ángulos de los mockups les sirven para una publicación de tienda?
- ¿El archivo de impresión se ve bien?

Cualquier feedback va con captura o un Loom corto al chat. Lo que les confunda, lo que les sorprenda, lo que les guste.

## Lo que todavía no está

- Guardar diseños / persistencia
- Agregar texto o formas (por ahora solo imágenes)
- Otros tamaños de taza (por ahora solo 11 oz cerámica blanca, panel frontal 270°)
- Móvil — el editor está bloqueado en pantallas chicas a propósito, es un flujo de escritorio

## Stack (info técnica)

HTML + JavaScript vanilla, Three.js para la escena 3D, sin build step. ~100 KB de código en total. La fuente de verdad vive en el repo Brain en `tools/mug-mockup/`; este repo público es una copia sincronizada para que prueben en el browser.
