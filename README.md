# Reparto Nestlé

App web para repartidores, pensada para usar desde el celular. Se carga la planilla de reparto (a mano o con una foto), se arma el orden del recorrido, se marca cómo pagó cada cliente y al final se obtiene el resumen de lo que tiene que haber.

## Qué hace

- **Planilla:** carga de clientes con importe y dirección (los importes negativos se tratan como notas de crédito), a mano o leyendo la foto de la planilla con IA (hasta 3 fotos a la vez, desde la cámara o la galería). Los repetidos (mismo nombre e importe) se quitan solos.
- **Recorrido:** el orden se arma tocando los clientes uno por uno. Cada cliente se marca con su medio de pago: efectivo, transferencia, cheque, E-Cheq, cuenta corriente, firmado, pago mixto, o rechazado (total o parcial, con motivo). En pago mixto y rechazo parcial el importe restante se calcula solo y se puede editar.
- **Resumen:** total de todos los pedidos, lo rechazado, lo que tiene que haber por medio de pago y los clientes pendientes de cobro (firmado, cuenta corriente, sin cobrar, sin visitar).
- **PDF:** exporta el resumen completo, con los clientes en el orden de la planilla original, y un PDF aparte solo con los pendientes.
- **Historial:** las planillas anteriores quedan guardadas y se pueden volver a abrir.
- **Configuración:** color de la app, cambio de nombre de usuario y contraseña, y alta de usuarios (solo el administrador).
- **Instalable en el celular** (PWA) y con aviso cuando no hay señal.

## Cómo guarda los datos

Las planillas viven **solo en la base de datos (Postgres)**. Cada cambio se envía al servidor al instante. Si el celular se queda sin señal, los cambios sin enviar quedan anotados en el celular y se suben solos cuando vuelve la conexión; apenas el servidor los confirma, se borran del celular. Si dos celulares editan la misma planilla a la vez, el que llega segundo no pisa al otro: sus cambios quedan en una planilla nueva y se avisa.

## Tecnología

- Frontend: HTML, CSS y JavaScript sin frameworks (`index.html`, `styles.css`, `app.js`, `logic.js`).
- Servidor: Node.js sin framework (`server.js`), con la librería `pg` para Postgres.
- Lectura de fotos: API de Anthropic (`api/leer.js`), llamada desde el servidor.

## Probar en local

```bash
npm install
npm start
```

Después abrí http://localhost:3000.

## Pruebas

```bash
npm test
```

Corre las pruebas de la lógica de importes y del servidor (login, usuarios, planillas, límite de fotos). Las que necesitan base de datos se activan definiendo `TEST_DATABASE_URL` con una base de pruebas (se borran sus tablas); sin ella se omiten. También corren solas en GitHub con cada cambio.

## Límites y seguridad

- La lectura de fotos tiene un tope de **3 fotos cada 10 minutos** (lo controla el servidor).
- Las contraseñas se guardan con hash (scrypt), nunca en texto, y las sesiones duran 30 días. Cambiar la contraseña cierra las sesiones abiertas de ese usuario.
- Por defecto todos los usuarios ven y editan las mismas planillas. El administrador puede cambiarlo en *Configuración* para que cada usuario vea solo las suyas (el administrador ve todas).

## Estructura

```
index.html      estructura de la página
app.js          la app (pantallas y acciones)
styles.css      estilos
server.js       servidor: archivos, login, usuarios, planillas y límite de fotos
api/leer.js     lectura de la foto de la planilla con IA
logic.js        lógica de importes y validación, compartida entre la app y el servidor
sw.js           service worker (instalable y abre sin señal)
test/           pruebas automáticas
manifest.json   datos de la app instalable, junto con los íconos
```

## Licencia

[MIT](LICENSE) © 2026 Rodriguez Nazareno.

Proyecto independiente, sin relación oficial con Nestlé S.A.: "Nestlé" se usa solo como nombre descriptivo del uso que se le da a la app. La licencia cubre el código, no marcas de terceros.
