# Reparto Nestle

App web para repartidores, pensada para usar desde el celular. Se carga la planilla de reparto (a mano o con una foto), se arma el orden del recorrido, se marca cómo pagó cada cliente y al final se obtiene el resumen de lo que tiene que haber.

## Qué hace

- **Planilla:** carga de clientes con importe y dirección, a mano o leyendo la foto de la planilla con IA (hasta 3 fotos a la vez, desde la cámara o la galería). Los repetidos (mismo nombre e importe) se quitan solos.
- **Recorrido:** el orden se arma tocando los clientes uno por uno. Cada cliente se marca con su medio de pago: efectivo, transferencia, cheque, E-Cheq, cuenta corriente, firmado, pago mixto, o rechazado (total o parcial, con motivo). En pago mixto y rechazo parcial el importe restante se calcula solo y se puede editar.
- **Resumen:** total de todos los pedidos, lo rechazado, lo que tiene que haber por medio de pago y los clientes pendientes de cobro (firmado, cuenta corriente, sin cobrar, sin visitar).
- **PDF:** exporta el resumen completo, con los clientes en el orden de la planilla original, y un PDF aparte solo con los pendientes.
- **Historial:** las planillas anteriores quedan guardadas y se pueden volver a abrir.
- **Configuración:** color de la app, cambio de nombre de usuario y contraseña, y alta de usuarios (solo el administrador).
- **Instalable en el celular** (PWA) y con aviso cuando no hay señal.

## Cómo guarda los datos

Las planillas viven **solo en la base de datos (Postgres)**. Cada cambio se envía al servidor al instante. Si el celular se queda sin señal, los cambios sin enviar quedan anotados en el celular y se suben solos cuando vuelve la conexión; apenas el servidor los confirma, se borran del celular.

## Tecnología

- Frontend: un único `index.html` (HTML, CSS y JavaScript, sin frameworks).
- Servidor: Node.js sin framework (`server.js`), con la librería `pg` para Postgres.
- Lectura de fotos: API de Anthropic (`api/leer.js`), llamada desde el servidor.
- Hosting pensado para [Railway](https://railway.app).

## Variables de entorno

| Variable | Para qué sirve |
| --- | --- |
| `DATABASE_URL` | Conexión a Postgres. En Railway se agrega como referencia al servicio de Postgres. |
| `ANTHROPIC_API_KEY` | Clave de la API para leer las fotos. Sin ella, la carga por foto no funciona. |
| `APP_USER` y `APP_PASS` | Usuario y contraseña del primer administrador. Se usan cuando todavía no existe ningún usuario en la base (o como único usuario si no hay base conectada). |
| `AUTH_SECRET` | Texto largo y aleatorio para firmar las sesiones. Recomendado definirlo. |
| `CLAUDE_MODEL` | Modelo de IA para leer las fotos (opcional). |
| `PORT` | Puerto del servidor (Railway lo define solo). |

**Importante:** definí `APP_USER`, `APP_PASS` y `AUTH_SECRET` propios antes de publicar la app, y cambiá la contraseña del administrador desde *Configuración* apenas la pongas en marcha. Nunca subas claves ni contraseñas al repositorio.

## Probar en local

```bash
npm install
npm start
```

Después abrí http://localhost:3000. Las tablas se crean solas al arrancar. Sin `DATABASE_URL` la app abre, pero avisa que los cambios no se guardan en el servidor.

## Publicar en Railway

1. Crear el proyecto desde este repositorio (rama `main`).
2. Agregar un servicio **PostgreSQL** y, en el servicio de la app, una variable `DATABASE_URL` que apunte al de Postgres.
3. Cargar las demás variables de la tabla de arriba.
4. Generar el dominio en *Settings → Networking* y abrirlo desde el celular. Para instalarla: *Agregar a pantalla de inicio* (en iPhone, desde Safari).
5. Activar los **backups de Postgres** en Railway: la base es la única copia de las planillas.

## Límites y seguridad

- La lectura de fotos tiene un tope de **3 fotos cada 10 minutos** (lo controla el servidor).
- Las contraseñas se guardan con hash (scrypt), nunca en texto y las sesiones duran 30 días. Cambiar la contraseña cierra las sesiones abiertas de ese usuario.
- El login se bloquea unos minutos después de 8 intentos fallidos.
- Todos los usuarios ven las mismas planillas.

## Estructura

```
index.html      la app (pantallas, lógica y estilos)
server.js       servidor: archivos, login, usuarios, planillas y límite de fotos
api/leer.js     lectura de la foto de la planilla con IA
sw.js           service worker (instalable y abre sin señal)
manifest.json   datos de la app instalable, junto con los íconos
```
